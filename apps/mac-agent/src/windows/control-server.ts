import http from "node:http";
import { randomBytes } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { z, ZodError } from "zod";
import type { AgentConfig, LocalApp } from "../../../../packages/shared/src/index.js";
import { wizardHtml, settingsHtml } from "./control-ui.js";
import { friendlySetupError } from "./setup-errors.js";

export type ConnectionState = "connected" | "connecting" | "offline" | "error";

export type RecentOp = {
  at: string;
  action: string;
  message: string;
};

export type ControlHooks = {
  getState: () => {
    connection: ConnectionState;
    server: string;
    paired: boolean;
    hasToken: boolean;
    version: string;
    folders: string[];
    autostart: boolean;
    apps: Array<{
      id: string;
      name: string;
      aliases: string[];
      enabled: boolean;
    }>;
    recentOps: RecentOp[];
    setupCompleted: boolean;
  };
  testConnection: (
    serverUrl: string,
    bootstrap?: string,
  ) => Promise<{ hasToken: boolean; connection: ConnectionState }>;
  startPair: (
    serverUrl: string,
    bootstrap?: string,
  ) => Promise<{ code: string; expiresAt: number }>;
  pairStatus: () => Promise<{
    paired: boolean;
    hasToken: boolean;
    agentOnline?: boolean;
  }>;
  ensureConnected: () => Promise<{
    hasToken: boolean;
    connection: ConnectionState;
  }>;
  pickFolder: () => Promise<string[]>;
  discoverApps: () => Promise<LocalApp[]>;
  saveAppToggles: (
    toggles: Array<{ id: string; enabled: boolean }>,
  ) => Promise<void>;
  updateApps: (
    apps: Array<{ id: string; enabled?: boolean; aliases?: string[] }>,
  ) => Promise<void>;
  completeSetup: () => Promise<void>;
  testCommand: () => Promise<{ success: boolean; message: string }>;
  saveConfig: (patch: Partial<AgentConfig>) => Promise<void>;
  toggleAutostart: () => Promise<{ autostart: boolean }>;
  pairAgain: () => Promise<{ code: string; expiresAt: number }>;
  reconnect: () => Promise<void>;
  openLog: () => Promise<void>;
  openSettings: () => Promise<void>;
  quit: () => Promise<void>;
};

export type ControlServer = {
  port: number;
  token: string;
  baseUrl: string;
  wizardUrl: string;
  settingsUrl: string;
  close: () => Promise<void>;
};

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(raw);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 512 * 1024) {
        reject(new Error("Слишком большой запрос"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Некорректный JSON"));
      }
    });
    req.on("error", reject);
  });
}

export async function startControlServer(hooks: ControlHooks): Promise<ControlServer> {
  const token = randomBytes(24).toString("base64url");

  const server = http.createServer(async (req, res) => {
    try {
      const host = "127.0.0.1";
      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/") {
        const pageToken = url.searchParams.get("t") ?? "";
        if (pageToken !== token) {
          res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Unauthorized");
          return;
        }
        const settings =
          url.searchParams.has("settings") ||
          url.searchParams.get("view") === "settings";
        const html = settings ? settingsHtml(token) : wizardHtml(token);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }

      if (!path.startsWith("/api/")) {
        res.writeHead(404);
        res.end();
        return;
      }

      const auth = req.headers["x-dauys-local"];
      if (auth !== token) {
        json(res, 401, {
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Нужен локальный токен" },
        });
        return;
      }

      if (method === "GET" && path === "/api/status") {
        json(res, 200, { ok: true, data: hooks.getState() });
        return;
      }

      if (method === "POST" && path === "/api/setup/test-connection") {
        const body = z
          .object({
            serverUrl: z.string().url({ message: "Укажите корректный адрес сервера" }).max(2048),
            bootstrap: z.string().max(500).optional(),
          })
          .parse(await readBody(req));
        const data = await hooks.testConnection(
          body.serverUrl,
          body.bootstrap?.trim() || undefined,
        );
        json(res, 200, { ok: true, data });
        return;
      }

      if (method === "POST" && path === "/api/setup/start-pair") {
        const body = z
          .object({
            serverUrl: z.string().url({ message: "Укажите корректный адрес сервера" }).max(2048),
            // Empty allowed when local token exists — validated in startPair hook.
            bootstrap: z.string().max(500).optional(),
          })
          .parse(await readBody(req));
        const data = await hooks.startPair(
          body.serverUrl,
          body.bootstrap?.trim() || undefined,
        );
        json(res, 200, { ok: true, data });
        return;
      }

      if (method === "POST" && path === "/api/setup/ensure-connected") {
        const data = await hooks.ensureConnected();
        json(res, 200, { ok: true, data });
        return;
      }

      if (method === "GET" && path === "/api/setup/pair-status") {
        json(res, 200, { ok: true, data: await hooks.pairStatus() });
        return;
      }

      if (method === "POST" && path === "/api/setup/folders") {
        const folders = await hooks.pickFolder();
        json(res, 200, { ok: true, data: { folders } });
        return;
      }

      if (method === "POST" && path === "/api/setup/discover-apps") {
        const apps = await hooks.discoverApps();
        json(res, 200, {
          ok: true,
          data: {
            apps: apps.map((a) => ({
              id: a.id,
              name: a.name,
              aliases: a.aliases,
              enabled: a.enabled,
            })),
          },
        });
        return;
      }

      if (method === "POST" && path === "/api/setup/save-apps") {
        const body = z
          .object({
            toggles: z
              .array(
                z.object({
                  id: z.string().min(1).max(80),
                  enabled: z.boolean(),
                }),
              )
              .max(200),
          })
          .parse(await readBody(req));
        await hooks.saveAppToggles(body.toggles);
        json(res, 200, { ok: true, data: { ok: true } });
        return;
      }

      if (method === "POST" && path === "/api/setup/complete") {
        await hooks.completeSetup();
        json(res, 200, { ok: true, data: { ok: true } });
        return;
      }

      if (method === "POST" && path === "/api/setup/test-command") {
        const data = await hooks.testCommand();
        json(res, 200, { ok: true, data });
        return;
      }

      if (method === "POST" && path === "/api/save-config") {
        const body = z
          .object({
            serverUrl: z.string().url().max(2048).optional(),
            allowedDirectories: z.array(z.string()).max(50).optional(),
            autostart: z.boolean().optional(),
          })
          .parse(await readBody(req));
        await hooks.saveConfig(body);
        json(res, 200, { ok: true, data: { ok: true } });
        return;
      }

      if (method === "POST" && path === "/api/update-apps") {
        const body = z
          .object({
            apps: z
              .array(
                z.object({
                  id: z.string().min(1).max(80),
                  enabled: z.boolean().optional(),
                  aliases: z.array(z.string().max(500)).max(30).optional(),
                }),
              )
              .max(200),
          })
          .parse(await readBody(req));
        await hooks.updateApps(body.apps);
        json(res, 200, { ok: true, data: { ok: true } });
        return;
      }

      if (method === "POST" && path === "/api/toggle-autostart") {
        json(res, 200, { ok: true, data: await hooks.toggleAutostart() });
        return;
      }

      if (method === "POST" && path === "/api/pair-again") {
        json(res, 200, { ok: true, data: await hooks.pairAgain() });
        return;
      }

      if (method === "POST" && path === "/api/reconnect") {
        await hooks.reconnect();
        json(res, 200, { ok: true, data: { ok: true } });
        return;
      }

      if (method === "POST" && path === "/api/open-log") {
        await hooks.openLog();
        json(res, 200, { ok: true, data: { ok: true } });
        return;
      }

      if (method === "POST" && path === "/api/open-settings") {
        await hooks.openSettings();
        json(res, 200, { ok: true, data: { ok: true } });
        return;
      }

      if (method === "POST" && path === "/api/quit") {
        json(res, 200, { ok: true, data: { ok: true } });
        setImmediate(() => {
          void hooks.quit();
        });
        return;
      }

      json(res, 404, {
        ok: false,
        error: { code: "NOT_FOUND", message: "Маршрут не найден" },
      });
    } catch (e) {
      const message =
        e instanceof ZodError
          ? friendlySetupError(
              e.issues.map((i) => i.message).join("; ") || e.message,
            )
          : friendlySetupError(e);
      json(res, 400, {
        ok: false,
        error: { code: "BAD_REQUEST", message },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string")
    throw new Error("Не удалось открыть локальный control-server");
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    token,
    baseUrl,
    wizardUrl: `${baseUrl}/?t=${encodeURIComponent(token)}`,
    settingsUrl: `${baseUrl}/?t=${encodeURIComponent(token)}&settings=1`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function openLocalUrl(url: string) {
  execFileCb(
    "cmd.exe",
    ["/c", "start", "", url],
    { windowsHide: true },
    () => undefined,
  );
}
