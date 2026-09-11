import { readFile, writeFile, mkdir, chmod, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { hostname } from "node:os";
import { z } from "zod";
import { trustSchema } from "../../../packages/shared/src/index.js";
import { MacExecutor } from "./executor.js";
import { ExecutionLedger } from "./safety.js";
import { AgentClient } from "./client.js";
import { askBootstrapSecret, showPairingCode } from "./dialog.js";
import { logger } from "./logger.js";
import {
  agentDataDir,
  defaultAllowedDirectories,
  defaultRealActions,
  defaultServerUrl,
  isStandalone,
} from "./paths.js";

async function main() {
  if (!isStandalone()) await import("dotenv/config");

  const env = process.env;
  const dataDir = agentDataDir();
  const tokenPath = env.AGENT_TOKEN_PATH ?? resolve(dataDir, "agent-token.json");
  const trustPath = env.AGENT_TRUST_PATH ?? resolve(dataDir, "agent-trust.json");
  const base = env.SERVER_PUBLIC_URL ?? defaultServerUrl();
  const url = new URL(base);
  const reset = process.argv.includes("--reset");
  const wantPairDialog = reset || process.argv.includes("--pair");
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Для удалённого сервера требуется HTTPS.");
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  if (reset) await rm(tokenPath, { force: true });
  let token: string | undefined;
  let hadToken = false;
  try {
    const stored = z
      .object({ token: z.string().min(32), server: z.string() })
      .parse(JSON.parse(await readFile(tokenPath, "utf8")));
    if (stored.server !== base)
      throw new Error("Сервер изменился: запустите агент с --reset");
    token = stored.token;
    hadToken = true;
    await chmod(tokenPath, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let bootstrap = env.AGENT_BOOTSTRAP_SECRET;
  if (!token && !bootstrap && isStandalone())
    bootstrap = await askBootstrapSecret();
  if (!token && !bootstrap)
    throw new Error(
      "Запустите pnpm setup:env или задайте AGENT_BOOTSTRAP_SECRET.",
    );
  const response = await fetch(new URL("/api/auth/pair/start", base), {
    method: "POST",
    headers: {
      Authorization: "Bearer " + (token ?? bootstrap),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: hostname() }),
    signal: AbortSignal.timeout(10000),
  });
  const raw = await response.json();
  if (!response.ok)
    throw new Error(
      "Не удалось создать код привязки: " +
        JSON.stringify(raw) +
        ". При отзыве токена используйте --reset.",
    );
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
  await writeFile(tokenPath, JSON.stringify({ token, server: base }), {
    mode: 0o600,
  });
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
    trust = trustSchema.parse(JSON.parse(await readFile(trustPath, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    trust = trustSchema.parse({ shortcuts: [], processes: {} });
    await writeFile(trustPath, JSON.stringify(trust, null, 2), { mode: 0o600 });
  }
  const ledger = new ExecutionLedger(
    resolve(dirname(tokenPath), "executions.db"),
  );
  const realActions = defaultRealActions();
  const executor = new MacExecutor({
    real: realActions,
    roots: (env.ALLOWED_DIRECTORIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .concat(env.ALLOWED_DIRECTORIES ? [] : defaultAllowedDirectories()),
    trust,
    dataDir: dirname(tokenPath),
    driveUrl: env.DRIVE_MCP_URL ?? "https://drive.esl.kz/mcp",
    driveToken:
      env.DRIVE_MCP_TOKEN ??
      (await readFile(resolve(dirname(tokenPath), "drive-mcp.token"), "utf8")
        .then((s) => s.trim())
        .catch(() => "")),
  });
  url.pathname = "/ws/mac-agent";
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const agent = new AgentClient({
    url: url.toString(),
    token,
    executor,
    ledger,
    logger,
    capabilities: {
      realActions,
      shortcuts: trust.shortcuts,
    },
    onAuthFailure: () => {
      logger.error(
        "Токен отозван. Для новой привязки запустите: dauys-agent --reset",
      );
      process.exit(0);
    },
  });
  agent.connect();
  logger.info({ realActions, dataDir, server: base }, "Режим агента");
  void executor
    .warmProjects()
    .catch((e) =>
      logger.warn({ message: (e as Error).message }, "Индекс проектов"),
    );
  for (const s of ["SIGINT", "SIGTERM"])
    process.on(s, () => {
      agent.close();
      ledger.close();
      process.exit(0);
    });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

