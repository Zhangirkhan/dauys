import { WebSocket } from "ws";
import { z } from "zod";
import type { AgentExecutor } from "./platform.js";
import type { ExecutionLedger } from "./safety.js";
import type { AgentLogger } from "./logger.js";
import type {
  AllowedAction,
  AgentPlatform,
} from "../../../packages/shared/src/index.js";

export type ConnectionState = "connected" | "connecting" | "offline" | "error";

type AppsCatalogEntry = { id: string; name: string; aliases: string[] };

export class AgentClient {
  private ws?: WebSocket;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private delay = 500;
  /** Old servers close on unknown frames — stop resending after reject. */
  private appsCatalogUnsupported = false;
  private pendingAppsCatalog: AppsCatalogEntry[] | undefined;
  constructor(
    private o: {
      url: string;
      token: string;
      executor: AgentExecutor;
      ledger: ExecutionLedger;
      logger: AgentLogger;
      capabilities?: {
        realActions: boolean;
        shortcuts: Array<{ id: string; name: string }>;
        platform?: AgentPlatform;
        supportedActions?: AllowedAction[];
      };
      onAuthFailure?: () => void;
      onConnectionChange?: (state: ConnectionState) => void;
    },
  ) {}
  private setConn(state: ConnectionState) {
    this.o.onConnectionChange?.(state);
  }
  connect() {
    if (this.stopped) return;
    this.setConn("connecting");
    const ws = new WebSocket(this.o.url, {
      headers: { Authorization: "Bearer " + this.o.token },
      maxPayload: 1024 * 1024,
      handshakeTimeout: 5000,
    });
    this.ws = ws;
    let queue = Promise.resolve();
    let lastSeen = Date.now();
    let catalogJustSent = false;
    ws.on("open", () => {
      this.delay = 500;
      const caps = this.o.capabilities ?? { realActions: false, shortcuts: [] };
      ws.send(
        JSON.stringify({
          type: "hello",
          realActions: caps.realActions,
          shortcuts: caps.shortcuts,
          ...(caps.platform ? { platform: caps.platform } : {}),
          ...(caps.supportedActions
            ? { supportedActions: caps.supportedActions }
            : {}),
        }),
      );
      this.setConn("connected");
      this.o.logger.info("Агент подключён");
      catalogJustSent = this.flushAppsCatalog(ws);
    });
    ws.on("ping", () => {
      lastSeen = Date.now();
    });
    const watchdog = setInterval(() => {
      if (Date.now() - lastSeen > 40000) ws.terminate();
    }, 10000);
    watchdog.unref();
    ws.on("message", (raw) => {
      queue = queue.then(async () => {
        if (this.stopped || ws !== this.ws || ws.readyState !== WebSocket.OPEN)
          return;
        let id: string | undefined;
        try {
          const msg = z
            .object({ type: z.literal("command"), envelope: z.unknown() })
            .strict()
            .parse(JSON.parse(raw.toString()));
          id = z.object({ id: z.string().uuid() }).parse(msg.envelope).id;
          const e = this.o.ledger.claim(msg.envelope);
          const result = await this.o.executor.execute(
            e.command,
            e.registry,
            e.confirmed,
            e.expiresAt,
          );
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "result", id: e.id, result }));
        } catch (e) {
          if (id && ws.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({
                type: "result",
                id,
                result: { success: false, message: (e as Error).message },
              }),
            );
          else ws.close(1008, "invalid command");
        }
      });
    });
    ws.on("error", (e) => {
      this.setConn("error");
      this.o.logger.warn({ message: e.message }, "Ошибка соединения");
    });
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.stopped = true;
        this.setConn("error");
        this.o.logger.error(
          "Токен отозван или неверен. Для новой привязки запустите агент с --reset.",
        );
        this.o.onAuthFailure?.();
      } else {
        this.setConn("error");
      }
      res.resume();
      ws.terminate();
    });
    ws.on("close", (code) => {
      clearInterval(watchdog);
      // Current production closes unknown frames with 1008 "Invalid frame".
      if (catalogJustSent && code === 1008 && !this.appsCatalogUnsupported) {
        this.appsCatalogUnsupported = true;
        this.pendingAppsCatalog = undefined;
        this.o.logger.warn(
          "Сервер не принимает apps_catalog — каталог приложений только локально. Для голосовых имён нужен обновлённый сервер.",
        );
      }
      if (code === 4001 || code === 4000) this.stopped = true;
      if (!this.stopped) {
        this.setConn("offline");
        this.retry = setTimeout(() => this.connect(), this.delay);
        this.delay = Math.min(this.delay * 2, 10000);
      } else {
        this.setConn("offline");
      }
    });
  }
  private flushAppsCatalog(ws: WebSocket) {
    if (this.appsCatalogUnsupported || !this.pendingAppsCatalog) return false;
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(
      JSON.stringify({
        type: "apps_catalog",
        applications: this.pendingAppsCatalog.map((a) => ({
          id: a.id,
          name: a.name,
          aliases: a.aliases,
        })),
      }),
    );
    return true;
  }
  sendAppsCatalog(apps: AppsCatalogEntry[]) {
    this.pendingAppsCatalog = apps.map((a) => ({
      id: a.id,
      name: a.name,
      aliases: a.aliases,
    }));
    if (this.appsCatalogUnsupported) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.flushAppsCatalog(this.ws);
  }
  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.ws?.terminate();
  }
}
