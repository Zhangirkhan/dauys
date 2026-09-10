import { compileDriveQuery } from "../../../packages/shared/src/index.js";

export const OFFICE_EXT = new Set([
  "doc",
  "docx",
  "docm",
  "rtf",
  "odt",
  "xls",
  "xlsx",
  "xlsm",
  "ods",
  "csv",
  "ppt",
  "pptx",
  "pptm",
  "odp",
]);

export type DriveHit = {
  id: number;
  kind: "file" | "folder";
  name: string;
  path: string;
  extension?: string;
  updated_at?: string;
  open?: string;
};

type McpJson = {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: { message?: string };
};

export function fileExtension(hit: { name: string; extension?: string }) {
  const field = (hit.extension ?? "").toLowerCase().replace(/^\./, "");
  if (field) return field;
  const dot = hit.name.lastIndexOf(".");
  if (dot <= 0) return "";
  return hit.name.slice(dot + 1).toLowerCase();
}

export function isOfficeFile(hit: {
  kind?: string;
  name: string;
  extension?: string;
}) {
  return hit.kind !== "folder" && OFFICE_EXT.has(fileExtension(hit));
}

export function driveOpenUrl(origin: string, hit: DriveHit) {
  const base = origin.replace(/\/$/, "");
  if (hit.open) {
    try {
      const url = new URL(hit.open);
      if (url.origin === new URL(base).origin) return url.toString();
    } catch {
      // Fall through to a constructed Drive URL.
    }
  }
  if (hit.kind === "folder")
    return base + "/app?folder=" + encodeURIComponent(String(hit.id));
  if (OFFICE_EXT.has(fileExtension(hit))) return base + "/app/office/" + hit.id;
  return base + "/app/preview/" + hit.id;
}

export function parseDriveHit(item: unknown): DriveHit | undefined {
  if (!item || typeof item !== "object") return undefined;
  const rec = item as Record<string, unknown>;
  const id = Number(rec.id);
  const name = String(rec.name ?? "");
  if (!id || !name) return undefined;
  const extension =
    typeof rec.extension === "string" ? rec.extension : undefined;
  return {
    id,
    kind: rec.kind === "folder" ? "folder" : "file",
    name,
    path: String(rec.path ?? "/"),
    extension,
    updated_at: typeof rec.updated_at === "string" ? rec.updated_at : undefined,
    open: typeof rec.open === "string" ? rec.open : undefined,
  };
}

export class DriveMcpClient {
  constructor(private o: { url: string; token: string; origin: string }) {}

  get origin() {
    return this.o.origin;
  }

  async upload(name: string, contents: string, base64 = false) {
    return this.call("upload_file", { name, contents, base64 });
  }

  async search(rawQuery: string) {
    const query = compileDriveQuery(rawQuery) || rawQuery.trim();
    const payload = await this.call("search_drive", { query });
    const folders = Array.isArray(payload.folders) ? payload.folders : [];
    const files = Array.isArray(payload.files) ? payload.files : [];
    const hits: DriveHit[] = [];
    for (const item of [...folders, ...files]) {
      const hit = parseDriveHit(item);
      if (hit) hits.push(hit);
    }
    return hits;
  }

  async get(fileId: number) {
    const hit = parseDriveHit(await this.call("get_file", { file_id: fileId }));
    if (!hit) throw new Error("Диск не вернул файл " + fileId);
    return hit;
  }

  async read(fileId: number) {
    const payload = await this.call("read_file", { file_id: fileId }, 45000);
    const encoding = String(payload.encoding ?? "");
    const content = String(payload.content ?? "");
    const truncated = Boolean(payload.truncated);
    const bytes =
      encoding === "base64"
        ? Buffer.from(content, "base64")
        : Buffer.from(content, "utf8");
    return { bytes, truncated, hit: parseDriveHit(payload) };
  }

  openUrl(hit: DriveHit) {
    return driveOpenUrl(this.o.origin, hit);
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 12000,
  ) {
    if (!this.o.token)
      throw new Error(
        "Нет токена диска. Создайте его на drive.esl.kz/app/admin/connect и сохраните в DRIVE_MCP_TOKEN или drive-mcp.token рядом с агентом.",
      );
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: "Bearer " + this.o.token,
    };
    const init = await this.post(
      headers,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "dauys", version: "0.1.0" },
        },
      },
      timeoutMs,
    );
    const session = init.headers.get("MCP-Session-Id");
    if (session) headers["MCP-Session-Id"] = session;
    headers["MCP-Protocol-Version"] =
      this.protocolVersion(init.body) ?? "2025-11-25";
    await this.post(
      headers,
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      timeoutMs,
    );
    const called = await this.post(
      headers,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      },
      timeoutMs,
    );
    return this.toolPayload(called.body);
  }

  private protocolVersion(body: unknown) {
    const rec = body as { result?: { protocolVersion?: string } };
    return rec?.result?.protocolVersion;
  }

  private toolPayload(body: unknown): Record<string, unknown> {
    const rpc = body as McpJson;
    if (rpc?.error?.message) throw new Error(rpc.error.message);
    const text = rpc?.result?.content?.find((c) => c.type === "text")?.text;
    if (rpc?.result?.isError) throw new Error(text || "Ошибка диска");
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { reply: text };
    }
  }

  private async post(
    headers: Record<string, string>,
    payload: unknown,
    timeoutMs: number,
  ) {
    const response = await fetch(this.o.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    if (response.status === 401 || response.status === 403)
      throw new Error(
        "Диск отказал в доступе. Проверьте токен MCP и что компания разрешена в DRIVE_MCP_COMPANY_SLUGS.",
      );
    if (!response.ok && response.status !== 202)
      throw new Error(
        "Диск ответил " +
          response.status +
          (raw ? ": " + raw.slice(0, 180) : ""),
      );
    return {
      headers: response.headers,
      body: this.parseBody(response.headers.get("content-type") ?? "", raw),
    };
  }

  private parseBody(contentType: string, raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    if (contentType.includes("text/event-stream")) {
      const lines = [...trimmed.matchAll(/^data:\s*(.+)$/gm)].map((m) => m[1]);
      const last = lines.filter((line) => line && line !== "[DONE]").at(-1);
      return last ? JSON.parse(last) : {};
    }
    return JSON.parse(trimmed);
  }
}

export function driveOriginFromMcp(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return "https://drive.esl.kz";
  }
}
