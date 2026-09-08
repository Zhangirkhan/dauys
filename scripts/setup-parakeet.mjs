import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
config();

const python = resolve(process.env.PARAKEET_PYTHON || ".venv/bin/python");
const model = process.env.PARAKEET_MODEL || "nvidia/parakeet-tdt-0.6b-v3";
const run = (args) => {
  const result = spawnSync(python, args, { stdio: "inherit", env: process.env });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
};
if (!existsSync(python)) {
  console.error("Python-окружение не найдено. Сначала выполните pnpm setup:stt");
  process.exit(1);
}
run([
  "-m",
  "pip",
  "install",
  "--upgrade",
  "git+https://github.com/huggingface/transformers",
  "soundfile",
]);
run(["-m", "pip", "install", "--no-deps", "librosa"]);
run([
  "-m",
  "pip",
  "install",
  "lazy_loader",
  "msgpack",
  "decorator",
  "pooch",
  "soxr",
  "joblib",
]);
run(["scripts/transcribe-parakeet.py", "--warmup", "--model", model]);
console.log("NVIDIA Parakeet загружен и готов.");
