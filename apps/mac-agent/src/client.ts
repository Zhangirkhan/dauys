import { WebSocket } from "ws";
import { z } from "zod";
import type { MacExecutor } from "./executor.js";
import type { ExecutionLedger } from "./safety.js";
import type { Logger } from "pino";
export class AgentClient {
  private ws?: WebSocket;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private delay = 500;
  constructor(
    private o: {
      url: string;
      token: string;
      executor: MacExecutor;
      ledger: ExecutionLedger;
      logger: Logger;
      capabilities?: {
        realActions: boolean;
        shortcuts: Array<{ id: string; name: string }>;
      };
    },
  ) {}
  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.o.url, {
      headers: { Authorization: "Bearer " + this.o.token },
      maxPayload: 1024 * 1024,
      handshakeTimeout: 5000,
    });
    this.ws = ws;
    let queue = Promise.resolve();
    let lastSeen = Date.now();
    ws.on("open", () => {
      this.delay = 500;
      ws.send(
        JSON.stringify({
          type: "hello",
          ...(this.o.capabilities ?? { realActions: false, shortcuts: [] }),
        }),
      );
      this.o.logger.info("Mac-агент подключён");
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
    ws.on("error", (e) =>
      this.o.logger.warn({ message: e.message }, "Ошибка соединения"),
    );
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.stopped = true;
        this.o.logger.error(
          "Токен отозван или неверен. Для новой привязки выполните pnpm dev:agent -- --reset.",
        );
      }
      res.resume();
      ws.terminate();
    });
    ws.on("close", (code) => {
      clearInterval(watchdog);
      if (code === 4001 || code === 4000) this.stopped = true;
      if (!this.stopped) {
        this.retry = setTimeout(() => this.connect(), this.delay);
        this.delay = Math.min(this.delay * 2, 10000);
      }
    });
  }
  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.ws?.terminate();
  }
}
