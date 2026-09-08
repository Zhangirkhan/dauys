import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import pino from "pino";
import { createApp } from "../apps/server/src/app.js";
import { Store, RegistryFile } from "../apps/server/src/store.js";
import { MockIntentResolver } from "../apps/server/src/intent.js";
import { MockSpeechToTextProvider } from "../apps/server/src/stt.js";
import { MacExecutor } from "../apps/mac-agent/src/executor.js";
import { ExecutionLedger } from "../apps/mac-agent/src/safety.js";
import { AgentClient } from "../apps/mac-agent/src/client.js";
import type { CommandRecord } from "../packages/shared/src/index.js";
let app: Awaited<ReturnType<typeof createApp>>,
  store: Store,
  dir: string,
  agent: AgentClient,
  ledger: ExecutionLedger,
  ws: WebSocket | undefined;
let cookie: string, agentId: string, agentToken: string, phoneId: string;
let uploadedPath = "";
const origin = "http://localhost:5173";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  fn: () => T | Promise<T>,
  predicate: (value: T) => boolean,
) {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (predicate(value)) return value;
    await delay(20);
  }
  throw new Error("Timed out");
}
const headers = () => ({ cookie, origin });
const send = (text: string) =>
  app.inject({
    method: "POST",
    url: "/api/text-command",
    headers: headers(),
    payload: { text },
  });
async function result(id: string) {
  return until(
    () =>
      app
        .inject({ url: "/api/commands/" + id, headers: headers() })
        .then((r) => r.json().data as CommandRecord),
    (c) =>
      ["done", "error", "confirmation", "clarification"].includes(c.status),
  );
}
async function connect() {
  agent = new AgentClient({
    url: app.listeningOrigin.replace("http:", "ws:") + "/ws/mac-agent",
    token: agentToken,
    executor: new MacExecutor({
      real: false,
      roots: [],
      trust: { shortcuts: [], processes: {} },
      dataDir: dir,
    }),
    ledger,
    logger: pino({ enabled: false }),
  });
  agent.connect();
  await until(
    () =>
      app
        .inject({ url: "/api/devices", headers: headers() })
        .then((r) => r.json().data as Array<{ role: string; online: boolean }>),
    (ds) => ds.some((d) => d.role === "agent" && d.online),
  );
}
beforeEach(async () => {
  uploadedPath = "";
  dir = await mkdtemp(join(tmpdir(), "voice-integration-"));
  store = new Store(join(dir, "db.sqlite"));
  const registry = new RegistryFile(join(dir, "registry.json"));
  app = await createApp({
    store,
    registry,
    resolver: new MockIntentResolver(),
    stt: {
      transcribe: async (path: string) => {
        uploadedPath = path;
        return new MockSpeechToTextProvider().transcribe(path);
      },
    },
    bootstrapSecret: "test-bootstrap-secret-that-is-long-enough",
    origins: [origin],
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  ledger = new ExecutionLedger(join(dir, "ledger.sqlite"));
  const a = await app.inject({
    method: "POST",
    url: "/api/auth/pair/start",
    headers: {
      authorization: "Bearer test-bootstrap-secret-that-is-long-enough",
    },
    payload: { name: "Test Mac" },
  });
  const data = a.json().data;
  agentId = data.deviceId;
  agentToken = data.token;
  const p = await app.inject({
    method: "POST",
    url: "/api/auth/pair/complete",
    headers: { origin },
    payload: { code: data.code, name: "Test Phone" },
  });
  cookie = String(p.headers["set-cookie"]).split(";")[0];
  phoneId = p.json().data.deviceId;
  await connect();
});
afterEach(async () => {
  ws?.terminate();
  ws = undefined;
  agent?.close();
  await app.close();
  ledger?.close();
  store?.close();
  await rm(dir, { recursive: true, force: true });
});
describe("HTTP + SQLite + real WebSocket + mock Mac executor", () => {
  it("executes the OTP scenario and delivers result through API and WebSocket", async () => {
    const events: CommandRecord[] = [];
    ws = new WebSocket(
      app.listeningOrigin.replace("http:", "ws:") + "/ws/client",
      { headers: headers() },
    );
    await new Promise<void>((res, rej) => {
      ws!.once("open", res);
      ws!.once("error", rej);
    });
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === "command") events.push(event.command);
    });
    const r = await send("Давай поработаем над OTP");
    expect(r.statusCode).toBe(202);
    const c = await result(r.json().data.id);
    expect(c.status).toBe("done");
    expect(c.command?.parameters).toEqual({ projectId: "cascade-otp" });
    expect(c.result?.data?.mock).toBe(true);
    await until(
      () => events,
      (es) => es.some((e) => e.status === "done"),
    );
    expect(store.context(agentId).activeProject).toBe("cascade-otp");
    const next = await send("И открой сайт");
    expect((await result(next.json().data.id)).command).toEqual({
      action: "open_url",
      parameters: { url: "https://cascade.kz" },
    });
  });
  it("requires confirmation, atomically consumes it and executes once", async () => {
    const r = await send("Заблокируй экран"),
      id = r.json().data.id;
    expect((await result(id)).status).toBe("confirmation");
    const first = await app.inject({
      method: "POST",
      url: `/api/commands/${id}/confirm`,
      headers: headers(),
      payload: { approved: true },
    });
    expect(first.statusCode).toBe(200);
    const repeated = await app.inject({
      method: "POST",
      url: `/api/commands/${id}/confirm`,
      headers: headers(),
      payload: { approved: true },
    });
    expect(repeated.statusCode).toBe(409);
    expect((await result(id)).status).toBe("done");
  });
  it("continues file selection by voice/text ordinal on the same command", async () => {
    const r = await send("Открой презентацию"),
      id = r.json().data.id;
    const c = await result(id);
    expect(c.status).toBe("clarification");
    expect(c.options).toHaveLength(2);
    const answer = await send("Первую");
    expect(answer.json().data.id).toBe(id);
    const done = await result(id);
    expect(done.status).toBe("done");
    expect(done.command?.action).toBe("open_file");
    expect(store.context(agentId).lastFile).toContain(
      "Презентация Cascade.pptx",
    );
  });
  it("opens latest PDF without unnecessary clarification", async () => {
    const r = await send("Открой последний PDF");
    const c = await result(r.json().data.id);
    expect(c.status).toBe("done");
    expect(c.command?.action).toBe("open_file");
  });
  it("authenticates all private APIs and rejects wrong Origin and device ownership", async () => {
    for (const url of ["/api/history", "/api/devices", "/api/config"])
      expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/pair/start",
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/config",
          headers: { cookie, origin: "https://evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    const command = await send("Проверь батарею");
    const other = store.createDevice("Other", "client", agentId);
    expect(
      (
        await app.inject({
          url: "/api/commands/" + command.json().data.id,
          headers: { authorization: "Bearer " + other.token },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("rejects unauthenticated WebSocket handshakes", async () => {
    const client = new WebSocket(
      app.listeningOrigin.replace("http:", "ws:") + "/ws/mac-agent",
    );
    const status = await new Promise<number>((res, rej) => {
      client.on("unexpected-response", (_q, r) => {
        res(r.statusCode ?? 0);
        r.resume();
        client.terminate();
      });
      client.on("open", () => rej(new Error("Unexpected authorized socket")));
      client.on("error", () => {});
    });
    expect(status).toBe(401);
  });
  it("expires confirmations and supports cancellation", async () => {
    const r = await send("Заблокируй экран");
    const c = await result(r.json().data.id);
    c.expiresAt = Date.now() - 1;
    store.save(c);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/commands/${c.id}/confirm`,
          headers: headers(),
          payload: { approved: true },
        })
      ).statusCode,
    ).toBe(410);
    const next = await send("Открой проект");
    const waiting = await result(next.json().data.id);
    expect(waiting.status).toBe("clarification");
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/commands/${waiting.id}/cancel`,
      headers: headers(),
      payload: {},
    });
    expect(cancelled.json().data.status).toBe("cancelled");
  });
  it("tracks disconnect/reconnect and revokes live devices", async () => {
    agent.close();
    await until(
      () =>
        app
          .inject({ url: "/api/devices", headers: headers() })
          .then((r) => r.json().data as Array<{ id: string; online: boolean }>),
      (ds) => ds.some((d) => d.id === agentId && !d.online),
    );
    const r = await send("Открой Cascade");
    expect((await result(r.json().data.id)).status).toBe("error");
    await connect();
    const rev = await app.inject({
      method: "DELETE",
      url: "/api/devices/" + phoneId,
      headers: headers(),
    });
    expect(rev.statusCode).toBe(200);
    expect(
      (await app.inject({ url: "/api/history", headers: headers() }))
        .statusCode,
    ).toBe(401);
  });
  it("accepts actual multipart audio in mock mode and removes uploaded files", async () => {
    const boundary = "voice-test-boundary";
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\nmock-bytes\r\n--${boundary}--\r\n`,
    );
    const r = await app.inject({
      method: "POST",
      url: "/api/voice",
      headers: {
        ...headers(),
        "content-type": "multipart/form-data; boundary=" + boundary,
      },
      payload,
    });
    expect(r.statusCode).toBe(202);
    const c = await result(r.json().data.id);
    expect(c.text).toBe("Давай поработаем над OTP");
    expect(c.status).toBe("done");
    expect(uploadedPath).not.toBe("");
    await until(
      () =>
        access(uploadedPath).then(
          () => false,
          () => true,
        ),
      (gone) => gone,
    );
  });
  it("persists config and rejects arbitrary scenario commands", async () => {
    const original = JSON.parse(
      await readFile(join(dir, "registry.json"), "utf8"),
    );
    original.projects[0].aliases.push("мой otp");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/config",
          headers: headers(),
          payload: original,
        })
      ).statusCode,
    ).toBe(200);
    original.projects[0].scenarios.bad = [
      { action: "shell", parameters: { command: "id" } },
    ];
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/config",
          headers: headers(),
          payload: original,
        })
      ).statusCode,
    ).toBe(400);
  });
});
