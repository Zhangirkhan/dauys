import { readFile, writeFile, mkdir, chmod, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { hostname } from "node:os";
import { isSea } from "node:sea";
import { z } from "zod";
import { trustSchema } from "../../../packages/shared/src/index.js";
import { ExecutionLedger } from "./safety.js";
import { AgentClient } from "./client.js";
import { askBootstrapSecret, showPairingCode } from "./dialog.js";
import { logger } from "./logger.js";
import {
  bootErr,
  bootLog,
  bootProcessBanner,
  bootStageDone,
  bootStageFail,
  bootStageStart,
} from "./boot-log.js";
import {
  agentDataDir,
  defaultAllowedDirectories,
  defaultRealActions,
  defaultServerUrl,
  isStandalone,
} from "./paths.js";
import { createExecutor, platformId } from "./platform.js";
import {
  ensureWindowsHelpers,
  protectUserFile,
} from "./windows/protect.js";

async function main() {
  const standalone = isStandalone();
  let sea = false;
  try {
    sea = isSea();
  } catch {
    sea = false;
  }
  bootProcessBanner({
    platform: process.platform,
    standalone,
    sea,
    execPath: process.execPath,
  });

  if (!standalone) {
    bootStageStart("dotenv");
    await import("dotenv/config");
    bootStageDone("dotenv");
  } else {
    bootLog("skip dotenv (standalone/SEA)");
  }

  const env = process.env;
  bootStageStart("resolvePaths");
  const dataDir = agentDataDir();
  const tokenPath = env.AGENT_TOKEN_PATH ?? resolve(dataDir, "agent-token.json");
  const trustPath = env.AGENT_TRUST_PATH ?? resolve(dataDir, "agent-trust.json");
  const base = env.SERVER_PUBLIC_URL ?? defaultServerUrl();
  const url = new URL(base);
  const reset = process.argv.includes("--reset");
  const wantPairDialog = reset || process.argv.includes("--pair");
  bootStageDone("resolvePaths", {
    dataDir,
    serverHost: url.host,
    serverProto: url.protocol.replace(":", ""),
    reset,
    pairFlag: wantPairDialog,
    hasBootstrapEnv: Boolean(env.AGENT_BOOTSTRAP_SECRET),
  });

  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Для удалённого сервера требуется HTTPS.");

  bootStageStart("mkdirData");
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  bootStageDone("mkdirData");

  let helpersDir = "";
  if (process.platform === "win32") {
    bootStageStart("ensureWindowsHelpers", { dataDir });
    try {
      helpersDir = await ensureWindowsHelpers(dataDir);
      bootStageDone("ensureWindowsHelpers", {
        helpers: basename(helpersDir),
      });
    } catch (e) {
      bootStageFail("ensureWindowsHelpers", e);
      throw e;
    }
  }

  if (reset) {
    bootStageStart("resetToken");
    await rm(tokenPath, { force: true });
    bootStageDone("resetToken");
  }

  let token: string | undefined;
  let hadToken = false;
  try {
    bootStageStart("readToken");
    const stored = z
      .object({ token: z.string().min(32), server: z.string() })
      .parse(JSON.parse(await readFile(tokenPath, "utf8")));
    if (stored.server !== base)
      throw new Error("Сервер изменился: запустите агент с --reset");
    token = stored.token;
    hadToken = true;
    bootStageDone("readToken", { hasToken: true });
    if (process.platform !== "win32") await chmod(tokenPath, 0o600);
    else if (helpersDir) {
      bootStageStart("protectTokenExisting");
      try {
        await protectUserFile(tokenPath, helpersDir);
        bootStageDone("protectTokenExisting");
      } catch (e) {
        bootStageFail("protectTokenExisting", e);
        throw e;
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      bootStageFail("readToken", e);
      throw e;
    }
    bootStageDone("readToken", { hasToken: false });
  }

  let bootstrap = env.AGENT_BOOTSTRAP_SECRET;
  if (!token && !bootstrap && standalone) {
    bootLog("no token — requesting bootstrap via dialog");
    bootstrap = await askBootstrapSecret();
  }
  if (!token && !bootstrap)
    throw new Error(
      "Запустите pnpm setup:env или задайте AGENT_BOOTSTRAP_SECRET.",
    );

  const pairUrl = new URL("/api/auth/pair/start", base);
  bootStageStart("pairStart", {
    host: pairUrl.host,
    path: pairUrl.pathname,
    auth: token ? "stored-token" : "bootstrap-env-or-dialog",
    timeoutMs: 10000,
  });
  let response: Response;
  try {
    response = await fetch(pairUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + (token ?? bootstrap),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: hostname() }),
      signal: AbortSignal.timeout(10000),
    });
    bootStageDone("pairStart", { httpStatus: response.status });
  } catch (e) {
    bootStageFail("pairStart", e);
    throw e;
  }

  bootStageStart("pairParse");
  const raw = await response.json();
  if (!response.ok) {
    bootStageFail("pairParse", new Error("HTTP " + response.status));
    throw new Error(
      "Не удалось создать код привязки: " +
        JSON.stringify(raw) +
        ". При отзыве токена используйте --reset.",
    );
  }
  const data = z
    .object({
      data: z.object({
        token: z.string().optional(),
        code: z.string(),
        expiresAt: z.number(),
        deviceId: z.string(),
      }),
    })
    .parse(raw).data;
  token = data.token ?? token;
  if (!token) throw new Error("Сервер не вернул токен");
  bootStageDone("pairParse", {
    hasCode: Boolean(data.code),
    deviceIdLen: data.deviceId.length,
  });

  bootStageStart("writeToken");
  await writeFile(tokenPath, JSON.stringify({ token, server: base }), {
    mode: 0o600,
  });
  bootStageDone("writeToken");
  if (process.platform === "win32" && helpersDir) {
    bootStageStart("protectTokenNew");
    try {
      await protectUserFile(tokenPath, helpersDir);
      bootStageDone("protectTokenNew");
    } catch (e) {
      bootStageFail("protectTokenNew", e);
      throw e;
    }
  }

  console.log(
    "\n  Код привязки телефона: " +
      data.code +
      " (5 минут)\n  Откройте " +
      base +
      " и введите этот код. Для нового кода: dauys-agent --pair\n",
  );
  if (!hadToken || wantPairDialog) showPairingCode(data.code, base);

  let trust;
  try {
    bootStageStart("loadTrust");
    trust = trustSchema.parse(JSON.parse(await readFile(trustPath, "utf8")));
    bootStageDone("loadTrust", { existing: true });
    if (process.platform === "win32" && helpersDir) {
      bootStageStart("protectTrust");
      try {
        await protectUserFile(trustPath, helpersDir);
        bootStageDone("protectTrust");
      } catch (e) {
        bootStageFail("protectTrust", e);
        throw e;
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      bootStageFail("loadTrust", e);
      throw e;
    }
    trust = trustSchema.parse({ shortcuts: [], processes: {} });
    await writeFile(trustPath, JSON.stringify(trust, null, 2), { mode: 0o600 });
    bootStageDone("loadTrust", { existing: false });
    if (process.platform === "win32" && helpersDir) {
      bootStageStart("protectTrust");
      try {
        await protectUserFile(trustPath, helpersDir);
        bootStageDone("protectTrust");
      } catch (e2) {
        bootStageFail("protectTrust", e2);
        throw e2;
      }
    }
  }

  const ledgerPath = resolve(dirname(tokenPath), "executions.db");
  bootStageStart("openLedger");
  const ledger = new ExecutionLedger(ledgerPath);
  bootStageDone("openLedger");
  if (process.platform === "win32" && helpersDir) {
    bootStageStart("protectLedger");
    try {
      await protectUserFile(ledgerPath, helpersDir);
      bootStageDone("protectLedger");
    } catch (e) {
      bootStageFail("protectLedger", e);
      /* db may be locked briefly; token/trust already protected */
    }
  }

  const realActions = defaultRealActions();
  bootStageStart("createExecutor");
  const executor = createExecutor({
    real: realActions,
    roots: (env.ALLOWED_DIRECTORIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .concat(env.ALLOWED_DIRECTORIES ? [] : defaultAllowedDirectories()),
    trust,
    dataDir: dirname(tokenPath),
  });
  bootStageDone("createExecutor", {
    realActions,
    platform: platformId(),
  });

  url.pathname = "/ws/mac-agent";
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  bootStageStart("wsConnect", { host: url.host, path: url.pathname });
  const agent = new AgentClient({
    url: url.toString(),
    token,
    executor,
    ledger,
    logger,
    capabilities: {
      realActions,
      shortcuts: trust.shortcuts,
      platform: platformId(),
      supportedActions: executor.supportedActions(),
    },
    onAuthFailure: () => {
      logger.error(
        "Токен отозван. Для новой привязки запустите: dauys-agent --reset",
      );
      process.exit(0);
    },
  });
  agent.connect();
  bootStageDone("wsConnect", { note: "handshake async; см. лог «Агент подключён»" });
  logger.info(
    { realActions, dataDir, server: base, platform: platformId() },
    "Режим агента",
  );
  bootLog("startup sequence finished (agent running)");
  void Promise.resolve(executor.warmProjects?.())
    .then(() => undefined)
    .catch((e: unknown) =>
      logger.warn(
        { message: e instanceof Error ? e.message : String(e) },
        "Индекс проектов",
      ),
    );
  for (const s of ["SIGINT", "SIGTERM"] as const)
    process.on(s, () => {
      agent.close();
      ledger.close();
      process.exit(0);
    });
}

void main().catch((error) => {
  bootErr("fatal", error);
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
