import "dotenv/config";
import { readFile, writeFile, mkdir, chmod, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { hostname } from "node:os";
import pino from "pino";
import { z } from "zod";
import { trustSchema } from "../../../packages/shared/src/index.js";
import { MacExecutor } from "./executor.js";
import { ExecutionLedger } from "./safety.js";
import { AgentClient } from "./client.js";
const env = process.env,
  logger = pino();
const tokenPath = env.AGENT_TOKEN_PATH ?? "./data/agent-token.json";
const base = env.SERVER_PUBLIC_URL ?? "http://localhost:8787";
const url = new URL(base);
if (
  url.protocol !== "https:" &&
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
)
  throw new Error("Для удалённого сервера требуется HTTPS.");
await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
if (process.argv.includes("--reset")) await rm(tokenPath, { force: true });
let token: string | undefined;
try {
  token = z
    .object({ token: z.string().min(32), server: z.string() })
    .parse(JSON.parse(await readFile(tokenPath, "utf8"))).token;
  const stored = JSON.parse(await readFile(tokenPath, "utf8"));
  if (stored.server !== base)
    throw new Error("Сервер изменился: используйте --reset");
  await chmod(tokenPath, 0o600);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
if (!token && !env.AGENT_BOOTSTRAP_SECRET)
  throw new Error("Запустите pnpm setup:env.");
const response = await fetch(new URL("/api/auth/pair/start", base), {
  method: "POST",
  headers: {
    Authorization: "Bearer " + (token ?? env.AGENT_BOOTSTRAP_SECRET),
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
    " (5 минут)\n  Откройте PWA и введите этот код. Для нового кода перезапустите агент.\n",
);
const trustPath = env.AGENT_TRUST_PATH ?? "./data/agent-trust.json";
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
const executor = new MacExecutor({
  real: env.ALLOW_REAL_MAC_ACTIONS === "true",
  roots: (env.ALLOWED_DIRECTORIES ?? "").split(",").filter(Boolean),
  trust,
  dataDir: dirname(tokenPath),
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
    realActions: env.ALLOW_REAL_MAC_ACTIONS === "true",
    shortcuts: trust.shortcuts,
  },
});
agent.connect();
logger.info(
  { realActions: env.ALLOW_REAL_MAC_ACTIONS === "true" },
  "Режим агента",
);
for (const s of ["SIGINT", "SIGTERM"])
  process.on(s, () => {
    agent.close();
    ledger.close();
    process.exit(0);
  });
