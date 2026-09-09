import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { WebSocket } from "ws";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z, ZodError } from "zod";
import {
  actionSchema,
  agentHelloSchema,
  appsCatalogSchema,
  decisionSchema,
  registrySchema,
  resultSchema,
  requiresConfirmation,
  type Action,
  type AgentHello,
  type CommandRecord,
  type ExecutionResult,
} from "../../../packages/shared/src/index.js";
import { Store, RegistryFile, type Device } from "./store.js";
import { type IntentResolver, ordinal } from "./intent.js";
import { preferSpokenNamedItem } from "./named-item.js";
import { preferSpokenUrl } from "./spoken-url.js";
import type { SpeechToTextProvider } from "./stt.js";
class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const ok = <T>(data: T) => ({ ok: true as const, data });
const terminal = (c: CommandRecord) =>
  ["done", "error", "cancelled"].includes(c.status);
export type AppOptions = {
  store: Store;
  registry: RegistryFile;
  resolver: IntentResolver;
  stt: SpeechToTextProvider;
  bootstrapSecret: string;
  origins: string[];
  secureCookie?: boolean;
  logger?: boolean;
  staticDir?: string;
  runtime?: { stt: string; intent: string };
};
export async function createApp(o: AppOptions) {
  const app = Fastify({
    logger: o.logger
      ? {
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            'res.headers["set-cookie"]',
          ],
        }
      : false,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 1 },
  });
  await app.register(websocket, { options: { maxPayload: 128 * 1024 } });
  let closing = false;
  const jobs = new Set<Promise<void>>();
  const background = (fn: () => Promise<void>) => {
    const job = Promise.resolve()
      .then(fn)
      .finally(() => jobs.delete(job));
    jobs.add(job);
  };
  const capabilities = new Map<string, AgentHello>();
  const agents = new Map<string, WebSocket>();
  const clients = new Map<WebSocket, Device>();
  const waiting = new Map<string, string>();
  const live = new Set<WebSocket>();
  const broadcast = (agentId: string, event: unknown) => {
    for (const [ws, d] of clients)
      if (d.agentId === agentId && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify(event));
  };
  const deviceList = (agentId: string) =>
    o.store.devices(agentId).map((d) => ({
      ...d,
      online:
        d.role === "agent"
          ? agents.get(d.id)?.readyState === WebSocket.OPEN
          : [...clients.values()].some((c) => c.id === d.id),
      platform:
        d.role === "agent" ? (capabilities.get(d.id)?.platform ?? null) : null,
    }));
  const notifyDevices = (id: string) =>
    broadcast(id, { type: "devices", devices: deviceList(id) });
  const save = (c: CommandRecord) => {
    if (closing) return;
    o.store.save(c);
    broadcast(c.agentId, { type: "command", command: c });
  };
  const stage = (
    c: CommandRecord,
    name: string,
    extra: Record<string, unknown> = {},
  ) => {
    app.log.info(
      {
        commandId: c.id,
        agentId: c.agentId,
        status: c.status,
        stage: name,
        action: c.command?.action,
        ...extra,
      },
      "command stage",
    );
  };
  const fail = (c: CommandRecord, message: string) => {
    if (closing || terminal(c) || terminal(o.store.command(c.id) ?? c)) return;
    c.status = "error";
    c.result = { success: false, message };
    app.log.warn(
      {
        commandId: c.id,
        agentId: c.agentId,
        action: c.command?.action,
        message: message.slice(0, 200),
      },
      "command failed",
    );
    save(c);
  };
  const authenticate = (req: FastifyRequest): Device => {
    const token =
      req.headers.authorization?.replace(/^Bearer /, "") ??
      req.cookies.voice_session;
    const d = token ? o.store.authenticate(token) : undefined;
    if (!d)
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "Привяжите устройство с помощью кода агента на компьютере.",
      );
    return d;
  };
  const client = (req: FastifyRequest) => {
    const d = authenticate(req);
    if (d.role !== "client")
      throw new ApiError(403, "CLIENT_REQUIRED", "Требуется токен телефона.");
    return d;
  };
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    const origin = req.headers.origin;
    if (origin && !o.origins.includes(origin))
      throw new ApiError(
        403,
        "ORIGIN_DENIED",
        "Origin не разрешён. Настройте PWA_ORIGIN.",
      );
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.cookies.voice_session &&
      !origin &&
      !req.headers.authorization
    )
      throw new ApiError(
        403,
        "ORIGIN_REQUIRED",
        "Для cookie-запросов нужен Origin.",
      );
  });
  app.setErrorHandler((err, _req, reply) => {
    const error = err as Error & { statusCode?: number; code?: string };
    const validation = err instanceof ZodError;
    const status = validation ? 400 : (error.statusCode ?? 500);
    reply.status(status).send({
      ok: false,
      error: {
        code: validation
          ? "VALIDATION_ERROR"
          : (error.code ?? "INTERNAL_ERROR"),
        message:
          status >= 500
            ? "Ошибка сервера. Проверьте локальные логи."
            : error.message,
      },
    });
    if (status >= 500) app.log.error({ err }, "Request failed");
  });
  const ownCommand = (req: FastifyRequest) => {
    const d = client(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = o.store.command(id);
    if (!c || c.deviceId !== d.id)
      throw new ApiError(404, "NOT_FOUND", "Команда не найдена");
    return c;
  };
  const active = (c: CommandRecord) => {
    if (Date.now() > c.expiresAt) {
      fail(c, "Время команды истекло. Повторите запрос.");
      throw new ApiError(410, "EXPIRED", "Срок команды истёк.");
    }
    if (terminal(c))
      throw new ApiError(409, "FINISHED", "Команда уже завершена.");
  };
  const policy = (command: Action) => {
    const registry = o.registry.get();
    switch (command.action) {
      case "open_application":
      case "close_application":
      case "new_browser_tab":
        if (
          !registry.applications.some(
            (a) => a.id === command.parameters.applicationId,
          )
        )
          throw new Error("Приложение отсутствует в реестре");
        break;
      case "open_project":
      case "run_scenario": {
        const project = registry.projects.find(
          (p) => p.id === command.parameters.projectId,
        );
        if (!project) throw new Error("Проект отсутствует в реестре");
        if (
          command.action === "run_scenario" &&
          !project.scenarios[command.parameters.scenarioId]
        )
          throw new Error("Сценарий отсутствует в реестре");
        break;
      }
      case "open_named_item":
      case "open_editor_project":
        if (
          command.parameters.applicationId &&
          !registry.applications.some(
            (a) => a.id === command.parameters.applicationId,
          )
        )
          throw new Error("Приложение отсутствует в реестре");
        break;
    }
  };
  const dispatch = (c: CommandRecord) => {
    active(c);
    if (!c.command) throw new Error("Нет команды");
    policy(c.command);
    if (
      (requiresConfirmation(c.command) ||
        (c.decision?.type === "execute" && c.decision.confirmationRequired)) &&
      !c.confirmed
    ) {
      c.status = "confirmation";
      stage(c, "confirmation", { action: c.command.action });
      save(c);
      return;
    }
    const ws = agents.get(c.agentId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      fail(
        c,
        "Компьютер не подключён. Запустите агент Рядом на Mac или Windows.",
      );
      return;
    }
    const caps = capabilities.get(c.agentId);
    if (
      caps?.supportedActions &&
      c.command &&
      !caps.supportedActions.includes(c.command.action)
    ) {
      fail(
        c,
        "Действие «" +
          c.command.action +
          "» не поддерживается подключённым агентом (" +
          (caps.platform ?? "unknown") +
          ").",
      );
      return;
    }
    c.status = "executing";
    save(c);
    const executionId = randomUUID();
    waiting.set(executionId, c.id);
    stage(c, "dispatch", { executionId });
    ws.send(
      JSON.stringify({
        type: "command",
        envelope: {
          id: executionId,
          createdAt: c.createdAt,
          expiresAt: c.expiresAt,
          confirmed: c.confirmed ?? false,
          command: c.command,
          registry: o.registry.get(),
        },
      }),
    );
  };
  const buildContext = (c: CommandRecord) => ({
    ...o.store.context(c.agentId),
    recent: o.store
      .history(c.agentId, 11)
      .filter((h) => h.id !== c.id)
      .slice(0, 10)
      .reverse()
      .map((h) => ({
        text: h.text,
        action: h.command?.action,
        response: h.result?.message ?? h.question,
      })),
  });
  const resolveIntent = async (c: CommandRecord, answer?: string) => {
    try {
      if (closing || terminal(o.store.command(c.id) ?? c)) return;
      const pending = answer
        ? { originalText: c.text, question: c.question, options: c.options }
        : undefined;
      c.status = "processing";
      save(c);
      const registry = o.registry.get();
      const spokenText = answer ? c.text + " " + answer : c.text;
      const decision = decisionSchema.parse(
        preferSpokenUrl(
          spokenText,
          registry,
          preferSpokenNamedItem(
            spokenText,
            registry,
            await o.resolver.resolve({
              text: answer ?? c.text,
              registry,
              context: buildContext(c),
              pending,
              shortcuts: capabilities.get(c.agentId)?.shortcuts,
            }),
          ),
        ),
      );
      if (closing) return;
      const current = o.store.command(c.id);
      if (!current || terminal(current)) return;
      active(c);
      c.decision = decision;
      stage(c, "intent", {
        decisionType: decision.type,
        action: decision.type === "execute" ? decision.action : undefined,
        textLen: (answer ?? c.text).length,
      });
      if (decision.type === "reject") {
        fail(c, decision.reason);
        return;
      }
      if (decision.type === "clarification") {
        c.status = "clarification";
        c.question = decision.question;
        c.options = decision.options;
        stage(c, "clarification");
        save(c);
        return;
      }
      c.command = actionSchema.parse({
        action: decision.action,
        parameters: decision.parameters,
      });
      if (
        (requiresConfirmation(c.command) || decision.confirmationRequired) &&
        !c.confirmed
      ) {
        stage(c, "confirmation-pending", { action: c.command.action });
      }
      dispatch(c);
    } catch (error) {
      app.log.error(
        {
          commandId: c.id,
          message:
            error instanceof Error ? error.message.slice(0, 200) : "unknown",
        },
        "intent background error",
      );
      fail(c, error instanceof Error ? error.message : "Ошибка обработки");
    }
  };
  const accept = (
    d: Device,
    text: string,
    status: CommandRecord["status"] = "processing",
  ) => {
    if (
      o.store
        .pending()
        .some((c) => c.agentId === d.agentId && c.expiresAt > Date.now())
    )
      throw new ApiError(
        409,
        "BUSY",
        "Завершите или отмените предыдущую команду.",
      );
    const now = Date.now();
    const c: CommandRecord = {
      id: randomUUID(),
      deviceId: d.id,
      agentId: d.agentId,
      text,
      status,
      createdAt: now,
      expiresAt: now + 60000,
    };
    save(c);
    return c;
  };
  const finish = (c: CommandRecord, result: ExecutionResult) => {
    if (terminal(c)) return;
    if (Date.now() > c.expiresAt) {
      fail(
        c,
        "Ответ Mac пришёл после истечения команды. Проверьте состояние Mac.",
      );
      return;
    }
    c.result = result;
    if (result.success && c.command?.action === "search_files") {
      const ctx = o.store.context(c.agentId);
      ctx.searchResults = result.files ?? [];
      if (result.files?.length === 1) ctx.lastFile = result.files[0].path;
      o.store.saveContext(c.agentId, ctx);
    }
    if (
      result.success &&
      (c.command?.action === "open_named_item" ||
        c.command?.action === "open_editor_project") &&
      result.files &&
      result.files.length > 1
    ) {
      c.files = result.files;
      c.status = "clarification";
      c.question = "Что открыть? Назовите номер.";
      c.options = result.files.map((f) => ({
        id: f.id,
        label: f.name + " · " + (f.host ? f.host + ":" : "") + f.path,
      }));
      save(c);
      return;
    }
    if (
      result.success &&
      c.command?.action === "search_files" &&
      c.command.parameters.open &&
      result.files?.length
    ) {
      c.files = result.files;
      const ctx = o.store.context(c.agentId);
      ctx.searchResults = result.files;
      o.store.saveContext(c.agentId, ctx);
      if (result.files.length === 1 || c.command.parameters.latest) {
        c.command = {
          action: "open_file",
          parameters: { path: result.files[0].path },
        };
        dispatch(c);
        return;
      }
      c.status = "clarification";
      c.question = "Какой файл открыть?";
      c.options = result.files.map((f) => ({
        id: f.id,
        label: f.name + " · " + f.path,
      }));
      save(c);
      return;
    }
    c.status = result.success ? "done" : "error";
    if (result.success) {
      const ctx = o.store.context(c.agentId);
      const command = c.command;
      if (
        command?.action === "open_project" ||
        command?.action === "run_scenario"
      )
        ctx.activeProject = command.parameters.projectId;
      if (command?.action === "open_application")
        ctx.lastApplication = command.parameters.applicationId;
      if (command?.action === "open_project") {
        const p = o.registry
          .get()
          .projects.find((p) => p.id === command.parameters.projectId);
        ctx.lastApplication =
          command.parameters.applicationId ??
          o.registry
            .get()
            .applications.find((a) => a.name === p?.defaultApplication)?.id;
      }
      if (command?.action === "open_file")
        ctx.lastFile = command.parameters.path;
      if (
        command?.action === "get_active_application" &&
        typeof result.data?.application === "string"
      )
        ctx.lastApplication = result.data.application;
      ctx.recent = [
        ...ctx.recent,
        { text: c.text, action: command?.action, response: result.message },
      ].slice(-10);
      o.store.saveContext(c.agentId, ctx);
    }
    save(c);
  };
  app.get("/health", async () => ok({ status: "ok" }));
  app.post(
    "/api/auth/pair/start",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      const body = z
        .object({ name: z.string().min(1).max(80).default("Компьютер") })
        .strict()
        .parse(req.body ?? {});
      const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      let d = o.store.authenticate(bearer);
      if (d?.role === "client")
        throw new ApiError(403, "AGENT_REQUIRED", "Код создаёт агент на компьютере.");
      if (!d) {
        const a = Buffer.from(bearer),
          b = Buffer.from(o.bootstrapSecret);
        if (!b.length || a.length !== b.length || !timingSafeEqual(a, b))
          throw new ApiError(
            401,
            "UNAUTHORIZED",
            "Требуется bootstrap-секрет агента",
          );
        d = o.store.createDevice(body.name, "agent");
        const token = (d as Device & { token: string }).token;
        return ok({ deviceId: d.id, token, ...o.store.pair(d.id) });
      }
      return ok({ deviceId: d.id, ...o.store.pair(d.id) });
    },
  );
  app.post(
    "/api/auth/pair/complete",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = z
        .object({
          code: z.string().regex(/^\d{8}$/),
          name: z.string().min(1).max(80).default("Мой телефон"),
        })
        .strict()
        .parse(req.body);
      try {
        const d = o.store.completePair(b.code, b.name);
        reply.setCookie("voice_session", d.token, {
          httpOnly: true,
          secure: o.secureCookie ?? false,
          sameSite: "strict",
          path: "/",
          maxAge: 60 * 60 * 24 * 90,
        });
        return ok({ deviceId: d.id, name: d.name, agentId: d.agentId });
      } catch (e) {
        throw new ApiError(400, "PAIR_FAILED", (e as Error).message);
      }
    },
  );
  app.post("/api/text-command", async (req, reply) => {
    const d = client(req);
    const b = z
      .object({ text: z.string().trim().min(1).max(4000) })
      .strict()
      .parse(req.body);
    const pending = o.store
      .pending()
      .find(
        (c) =>
          c.deviceId === d.id &&
          c.status === "clarification" &&
          c.expiresAt > Date.now(),
      );
    if (pending) {
      await clarify(pending, b.text);
      return reply.status(202).send(ok(o.store.command(pending.id)));
    }
    const c = accept(d, b.text);
    background(() => resolveIntent(c));
    return reply.status(202).send(ok(c));
  });
  const clarify = async (c: CommandRecord, answer: string) => {
    active(c);
    if (c.status !== "clarification")
      throw new ApiError(
        409,
        "NOT_CLARIFYING",
        "Команда не ожидает уточнения.",
      );
    if (c.files?.length) {
      const i = ordinal(answer);
      const f =
        c.files.find((f) => f.id === answer || f.name === answer) ??
        (i === undefined ? undefined : c.files[i]);
      if (!f) {
        c.question = "Выберите файл или папку из списка или скажите номер.";
        save(c);
        return;
      }
      c.command =
        f.kind === "project"
          ? {
              action: "open_editor_project",
              parameters: { query: f.name, projectKey: f.id },
            }
          : f.kind === "folder"
            ? { action: "open_folder", parameters: { path: f.path } }
            : { action: "open_file", parameters: { path: f.path } };
      c.confirmed = false;
      dispatch(c);
      return;
    }
    await resolveIntent(c, answer);
  };
  app.post("/api/voice", async (req, reply) => {
    const d = client(req);
    const file = await req.file();
    if (!file)
      throw new ApiError(400, "AUDIO_REQUIRED", "Прикрепите аудиофайл");
    if (
      !/^audio\/(webm|mp4|mpeg|ogg|wav|x-wav|aac)(;.*)?$/.test(file.mimetype)
    ) {
      file.file.resume();
      throw new ApiError(415, "AUDIO_FORMAT", "Неподдерживаемый формат аудио");
    }
    const buffer = await file.toBuffer();
    if (!buffer.length) throw new ApiError(400, "EMPTY_AUDIO", "Запись пуста");
    const pending = o.store
      .pending()
      .find(
        (c) =>
          c.deviceId === d.id &&
          c.status === "clarification" &&
          c.expiresAt > Date.now(),
      );
    const c = pending ?? accept(d, "", "transcribing");
    if (pending) {
      pending.status = "transcribing";
      save(pending);
    }
    const dir = await mkdtemp(join(tmpdir(), "voice-upload-"));
    try {
      await writeFile(join(dir, "input"), buffer, { mode: 0o600 });
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      fail(c, "Не удалось сохранить аудио");
      throw e;
    }
    background(async () => {
      const started = Date.now();
      try {
        stage(c, "stt-start");
        const t = await o.stt.transcribe(join(dir, "input"));
        const sttMs = Date.now() - started;
        if (closing) return;
        const current = o.store.command(c.id);
        if (!current || terminal(current)) return;
        active(c);
        const text = (t.text ?? "").trim();
        stage(c, "stt-done", { sttMs, textLen: text.length });
        if (!pending && !text) {
          fail(c, "Не удалось распознать речь. Повторите.");
          return;
        }
        const intentStarted = Date.now();
        if (pending) {
          c.status = "clarification";
          await clarify(c, text);
        } else {
          c.text = text;
          await resolveIntent(c);
        }
        app.log.info(
          {
            commandId: c.id,
            sttMs,
            intentMs: Date.now() - intentStarted,
            totalMs: Date.now() - started,
            textLen: text.length,
            status: (o.store.command(c.id) ?? c).status,
            action: (o.store.command(c.id) ?? c).command?.action,
          },
          "voice pipeline",
        );
      } catch (e) {
        app.log.error(
          {
            commandId: c.id,
            message: (e as Error).message?.slice(0, 200),
          },
          "voice pipeline failed",
        );
        fail(c, (e as Error).message);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    return reply.status(202).send(ok(c));
  });
  app.get("/api/commands/:id", async (req) => ok(ownCommand(req)));
  app.post("/api/commands/:id/confirm", async (req) => {
    const c = ownCommand(req);
    active(c);
    z.object({ approved: z.literal(true) })
      .strict()
      .parse(req.body);
    if (c.status !== "confirmation")
      throw new ApiError(
        409,
        "NOT_CONFIRMING",
        "Команда не ожидает подтверждения",
      );
    c.confirmed = true;
    dispatch(c);
    return ok(c);
  });
  app.post("/api/commands/:id/clarify", async (req) => {
    const c = ownCommand(req);
    const b = z
      .object({ answer: z.string().trim().min(1).max(4000) })
      .strict()
      .parse(req.body);
    await clarify(c, b.answer);
    return ok(o.store.command(c.id));
  });
  app.post("/api/commands/:id/cancel", async (req) => {
    const c = ownCommand(req);
    active(c);
    if (c.status === "executing")
      throw new ApiError(
        409,
        "ALREADY_SENT",
        "Команда уже отправлена на компьютер; отменить системное действие нельзя.",
      );
    c.status = "cancelled";
    c.result = { success: false, message: "Отменено" };
    save(c);
    return ok(c);
  });
  app.get("/api/runtime", async (req) => {
    const d = client(req);
    return ok({
      ...o.runtime,
      deviceId: d.id,
      realActions: capabilities.get(d.agentId)?.realActions ?? false,
      platform: capabilities.get(d.agentId)?.platform ?? null,
      supportedActions: capabilities.get(d.agentId)?.supportedActions ?? null,
    });
  });
  app.get("/api/history", async (req) =>
    ok(o.store.history(client(req).agentId)),
  );
  app.get("/api/devices", async (req) => ok(deviceList(client(req).agentId)));
  // Agent polls pairing without phone cookie; never expose tokens/bootstrap.
  app.get("/api/agent/status", async (req) => {
    const d = authenticate(req);
    if (d.role !== "agent")
      throw new ApiError(403, "AGENT_REQUIRED", "Требуется токен агента");
    const linked = o.store
      .devices(d.agentId)
      .filter((x) => x.role === "client" && !x.revoked);
    const onlineClients = [...clients.values()].filter(
      (c) => c.agentId === d.agentId && c.role === "client",
    ).length;
    return ok({
      paired: linked.length > 0,
      clients: onlineClients,
    });
  });
  app.delete("/api/devices/:id", async (req, reply) => {
    const d = client(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!o.store.devices(d.agentId).some((x) => x.id === id))
      throw new ApiError(404, "NOT_FOUND", "Устройство не найдено");
    o.store.revoke(id);
    for (const [ws, c] of clients)
      if (c.id === id || id === c.agentId) ws.close(4001, "revoked");
    agents.get(id)?.close(4001, "revoked");
    for (const c of o.store.pending())
      if (c.deviceId === id || c.agentId === id) fail(c, "Устройство отозвано");
    if (id === d.id || id === d.agentId)
      reply.clearCookie("voice_session", { path: "/" });
    notifyDevices(d.agentId);
    return ok({ revoked: id });
  });
  app.get("/api/config", async (req) => {
    client(req);
    return ok(o.registry.get());
  });
  app.put("/api/config", async (req) => {
    client(req);
    if (o.store.pending().length)
      throw new ApiError(
        409,
        "BUSY",
        "Сначала завершите команды, затем меняйте настройки.",
      );
    return ok(o.registry.set(registrySchema.parse(req.body)));
  });
  function track(ws: WebSocket) {
    live.add(ws);
    ws.on("pong", () => live.add(ws));
    ws.on("error", () => {});
    ws.on("close", () => live.delete(ws));
  }
  app.get(
    "/ws/client",
    {
      websocket: true,
      preValidation: async (req) => {
        client(req);
        if (!req.headers.origin || !o.origins.includes(req.headers.origin))
          throw new ApiError(
            403,
            "ORIGIN_DENIED",
            "WebSocket Origin обязателен",
          );
      },
    },
    (ws, req) => {
      const d = client(req);
      clients.set(ws, d);
      track(ws);
      ws.send(
        JSON.stringify({ type: "devices", devices: deviceList(d.agentId) }),
      );
      ws.on("close", () => {
        clients.delete(ws);
      });
    },
  );
  app.get(
    "/ws/mac-agent",
    {
      websocket: true,
      preValidation: async (req) => {
        if (authenticate(req).role !== "agent")
          throw new ApiError(403, "AGENT_REQUIRED", "Требуется токен агента");
      },
    },
    (ws, req) => {
      const d = authenticate(req);
      agents.get(d.id)?.close(4000, "replaced");
      agents.set(d.id, ws);
      track(ws);
      notifyDevices(d.id);
      ws.on("message", (raw) => {
        if (closing) return;
        try {
          const rawMessage = JSON.parse(raw.toString());
          if (rawMessage.type === "hello") {
            const hello = agentHelloSchema.parse(rawMessage);
            capabilities.set(d.id, hello);
            notifyDevices(d.id);
            return;
          }
          // Windows agent pushes name/aliases only — registry.path from clients is ignored (local exe map stays on PC).
          if (rawMessage.type === "apps_catalog") {
            const apps = Array.isArray(rawMessage.applications)
              ? rawMessage.applications.map(
                  (a: { id?: unknown; name?: unknown; aliases?: unknown }) => ({
                    id: a.id,
                    name: a.name,
                    aliases: a.aliases,
                  }),
                )
              : [];
            const catalog = appsCatalogSchema.parse({
              type: "apps_catalog",
              applications: apps,
            });
            o.registry.mergeAppsCatalog(catalog.applications);
            return;
          }
          const msg = z
            .object({
              type: z.literal("result"),
              id: z.string().uuid(),
              result: resultSchema,
            })
            .strict()
            .parse(JSON.parse(raw.toString()));
          const commandId = waiting.get(msg.id);
          if (!commandId) return;
          const c = o.store.command(commandId);
          if (!c || c.agentId !== d.id || agents.get(d.id) !== ws) return;
          waiting.delete(msg.id);
          stage(c, "result", {
            executionId: msg.id,
            success: msg.result.success,
            message: (msg.result.message ?? "").slice(0, 120),
          });
          finish(c, msg.result);
        } catch (e) {
          app.log.warn(
            { message: (e as Error).message },
            "Invalid agent frame",
          );
          ws.close(1008, "Invalid frame");
        }
      });
      ws.on("close", () => {
        if (closing || agents.get(d.id) !== ws) return;
        agents.delete(d.id);
        for (const [eid, cid] of waiting) {
          const c = o.store.command(cid);
          if (c?.agentId === d.id) {
            waiting.delete(eid);
            fail(
              c,
              "Связь с компьютером потеряна. Команда не повторяется автоматически; проверьте результат на компьютере.",
            );
          }
        }
        notifyDevices(d.id);
      });
    },
  );
  const timer = setInterval(() => {
    for (const c of o.store.pending())
      if (c.expiresAt < Date.now())
        fail(c, "Время команды истекло. Повторите запрос.");
    for (const [id, cid] of waiting) {
      const c = o.store.command(cid);
      if (!c || terminal(c)) waiting.delete(id);
    }
  }, 500);
  timer.unref();
  const heartbeat = setInterval(() => {
    for (const ws of [...agents.values(), ...clients.keys()]) {
      if (!live.has(ws)) {
        ws.terminate();
        continue;
      }
      live.delete(ws);
      ws.ping();
    }
  }, 15000);
  heartbeat.unref();
  if (o.staticDir && existsSync(o.staticDir)) {
    await app.register(fastifyStatic, {
      root: resolve(o.staticDir),
      maxAge: 0,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/ws/"))
        return reply.status(404).send({
          ok: false,
          error: { code: "NOT_FOUND", message: "Маршрут не найден" },
        });
      return reply.sendFile("index.html");
    });
  }
  app.addHook("preClose", async () => {
    closing = true;
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    for (const ws of [...agents.values(), ...clients.keys()]) ws.terminate();
    await Promise.allSettled(jobs);
  });
  return app;
}
