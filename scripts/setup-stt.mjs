import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
config();
const check = process.argv.includes("--check");
const probe = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
function run(cmd, args, env = process.env) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env });
  if (r.error || r.status !== 0)
    throw new Error("Не удалось выполнить " + cmd + " " + args.join(" "));
}
try {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error(
      "mlx-whisper требует macOS Apple Silicon. Запускайте STT на Mac; в Docker используйте STT_PROVIDER=mock.",
    );
  if (probe("ffmpeg", ["-version"]).status !== 0)
    throw new Error("Установите FFmpeg: brew install ffmpeg");
  const python = ["python3.12", "python3.13", "python3"].find(
    (p) =>
      probe(p, ["-c", "import sys; assert sys.version_info >= (3,10)"])
        .status === 0,
  );
  if (!python)
    throw new Error(
      "Нужен Python >=3.10. Установите: brew install python@3.12",
    );
  const target = resolve(process.env.WHISPER_PYTHON || ".venv/bin/python");
  console.log(
    "Apple Silicon; FFmpeg найден; " +
      probe(python, ["--version"]).stdout.trim(),
  );
  if (check) {
    if (!existsSync(target))
      throw new Error(
        "Окружение Whisper ещё не установлено. Запустите pnpm setup:stt",
      );
    run(target, [
      "-c",
      'import mlx_whisper; import mlx.core as mx; print("MLX device:", mx.default_device())',
    ]);
    run(
      target,
      [
        "scripts/transcribe.py",
        "--warmup",
        "--model",
        process.env.WHISPER_MODEL || "small",
        "--language",
        process.env.WHISPER_LANGUAGE || "ru",
      ],
      { ...process.env, HF_HUB_OFFLINE: "1" },
    );
  } else {
    if (!existsSync(target)) {
      if (
        process.env.WHISPER_PYTHON &&
        process.env.WHISPER_PYTHON !== "./.venv/bin/python"
      )
        throw new Error(
          "WHISPER_PYTHON указывает на отсутствующий интерпретатор. Используйте ./.venv/bin/python или создайте своё venv.",
        );
      run(python, ["-m", "venv", ".venv"]);
    }
    run(target, ["-m", "pip", "install", "--upgrade", "pip"]);
    run(target, ["-m", "pip", "install", "mlx-whisper==0.4.3"]);
    run(target, [
      "-c",
      'import mlx_whisper; import mlx.core as mx; print("MLX device:", mx.default_device())',
    ]);
    console.log(
      "Загружаем модель заранее, чтобы первая команда уложилась в 60 секунд.",
    );
    run(target, [
      "scripts/transcribe.py",
      "--warmup",
      "--model",
      process.env.WHISPER_MODEL || "small",
      "--language",
      process.env.WHISPER_LANGUAGE || "ru",
    ]);
  }
  console.log("Локальный STT готов. Установите STT_PROVIDER=local в .env.");
} catch (e) {
  console.error(e.message);
  console.error(
    "Если Python несовместим: brew install python@3.12; затем создайте новый venv командой python3.12 -m venv .venv и повторите pnpm setup:stt.",
  );
  process.exitCode = 1;
}
