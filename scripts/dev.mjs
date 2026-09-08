import { spawn } from "node:child_process";
import { setupEnv } from "./setup-env.mjs";
import { config } from "dotenv";
setupEnv();
config();
const production = process.argv.includes("--production");
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
  setTimeout(() => {
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGKILL");
    process.exit(code);
  }, 65000).unref();
}
function start(command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  children.push(child);
  child.once("error", (e) => {
    console.error(e.message);
    stop(1);
  });
  child.once("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => stop());
start(
  production ? "node" : "pnpm",
  production ? ["apps/server/dist/index.js"] : ["dev:server"],
);
let ready = false;
for (let i = 0; i < 80 && !stopping; i++) {
  try {
    const r = await fetch(
      "http://127.0.0.1:" + (process.env.PORT ?? 8787) + "/health",
      { signal: AbortSignal.timeout(500) },
    );
    if (r.ok) {
      ready = true;
      break;
    }
  } catch {
    /* Wait for server startup. */
  }
  await new Promise((r) => setTimeout(r, 250));
}
if (!ready) {
  console.error("Backend не запустился за 20 секунд");
  stop(1);
} else {
  start(
    production ? "node" : "pnpm",
    production ? ["apps/mac-agent/dist/index.js"] : ["dev:agent"],
  );
  if (!production) start("pnpm", ["dev:pwa"]);
  console.log(
    production
      ? "PWA: " + (process.env.SERVER_PUBLIC_URL ?? "http://localhost:8787")
      : "PWA: http://localhost:5173",
  );
}
