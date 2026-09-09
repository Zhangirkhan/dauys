import { compileDriveQuery } from "../../../packages/shared/src/index.js";

const OFFICE = new Set([
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
]);

export type DriveHit = {
  id: number;
  kind: "file" | "folder";
  name: string;
  path: string;
  extension?: string;
  updated_at?: string;
};

type McpJson = {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: { message?: string };
};

export class DriveMcpClient {
  constructor(
    private o: { url: string; token: string; origin: string },
  ) {}

  async search(rawQuery: string) {
    const query = compileDriveQuery(rawQuery) || rawQuery.trim();
    const payload = await this.call("search_drive", { query });
    const folders = Array.isArray(payload.folders) ? payload.folders : [];
    const files = Array.isArray(payload.files) ? payload.files : [];
    const hits: DriveHit[] = [];
    for (const item of [...folders, ...files]) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const id = Number(rec.id);
      const name = String(rec.name ?? "");
      if (!id || !name) continue;
      hits.push({
        id,
        kind: rec.kind === "folder" ? "folder" : "file",
        name,
        path: String(rec.path ?? "/"),
        extension:
          typeof rec.extension === "string" ? rec.extension : undefined,
        updated_at:
          typeof rec.updated_at === "string" ? rec.updated_at : undefined,
      });
    }
    return hits;
  }

  openUrl(hit: DriveHit) {
    const base = this.o.origin.replace(/\/$/, "");
    if (hit.kind === "folder")
      return base + "/app?folder=" + encodeURIComponent(String(hit.id));
    const ext = (hit.extension ?? "").toLowerCase();
    if (OFFICE.has(ext)) return base + "/app/office/" + hit.id;
    return base + "/app/preview/" + hit.id;
  }

  private async call(name: string, args: Record<string, unknown>) {
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
    );
    const session = init.headers.get("MCP-Session-Id");
    if (session) headers["MCP-Session-Id"] = session;
    headers["MCP-Protocol-Version"] =
      this.protocolVersion(init.body) ?? "2025-11-25";
    await this.post(headers, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    const called = await this.post(headers, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    });
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

  private async post(headers: Record<string, string>, payload: unknown) {
    const response = await fetch(this.o.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    });
    const raw = await response.text();
    if (response.status === 401 || response.status === 403)
      throw new Error(
        "Диск отказал в доступе. Проверьте токен MCP и что компания разрешена в DRIVE_MCP_COMPANY_SLUGS.",
      );
    if (!response.ok && response.status !== 202)
      throw new Error(
        "Диск ответил " + response.status + (raw ? ": " + raw.slice(0, 180) : ""),
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
