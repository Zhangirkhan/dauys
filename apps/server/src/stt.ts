import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { z } from "zod";
const run = promisify(execFile);
export interface SpeechToTextProvider {
  transcribe(
    audioPath: string,
  ): Promise<{ text: string; language?: string; durationMs?: number }>;
}
export class MockSpeechToTextProvider implements SpeechToTextProvider {
  constructor(private text = "Давай поработаем над OTP") {}
  async transcribe(_audioPath: string) {
    return { text: this.text, language: "ru", durationMs: 1000 };
  }
}
async function toWav(audioPath: string, wav: string) {
  try {
    await run(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "matroska,webm,mov,mp3,ogg,wav,aac",
        "-i",
        resolve(audioPath),
        "-t",
        "20",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-y",
        wav,
      ],
      { timeout: 12000, maxBuffer: 1024 * 1024 },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("FFmpeg не найден. Установите: brew install ffmpeg");
    throw new Error("Не удалось прочитать аудио. Запишите команду ещё раз.");
  }
}
export class HttpWhisperProvider implements SpeechToTextProvider {
  constructor(
    private options: { url: string; language?: string },
  ) {}
  async transcribe(audioPath: string) {
    const dir = await mkdtemp(join(tmpdir(), "voice-whisper-"));
    try {
      const wav = join(dir, "audio.wav");
      await toWav(audioPath, wav);
      const buffer = await readFile(wav);
      const form = new FormData();
      form.append(
        "audio_file",
        new Blob([new Uint8Array(buffer)], { type: "audio/wav" }),
        "audio.wav",
      );
      const endpoint = new URL("/asr", this.options.url);
      endpoint.searchParams.set("task", "transcribe");
      endpoint.searchParams.set("output", "json");
      if (this.options.language)
        endpoint.searchParams.set("language", this.options.language);
      const response = await fetch(endpoint, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(40000),
      });
      if (!response.ok)
        throw new Error("Whisper HTTP " + response.status);
      const raw = await response.json();
      return z
        .object({
          text: z.string().trim().min(1).max(4000),
          language: z.string().optional(),
        })
        .parse(raw);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
class LocalPythonSttProvider implements SpeechToTextProvider {
  constructor(
    protected options: {
      python: string;
      model: string;
      language?: string;
      script: string;
      label: string;
      timeout?: number;
    },
  ) {}
  protected async transcribeWav(wav: string) {
    const { stdout } = await run(
      resolve(this.options.python),
      [
        resolve(this.options.script),
        wav,
        "--model",
        this.options.model,
        ...(this.options.language ? ["--language", this.options.language] : []),
      ],
      {
        timeout: this.options.timeout ?? 40000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, HF_HUB_OFFLINE: "1" },
      },
    );
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  }
  async transcribe(audioPath: string) {
    const dir = await mkdtemp(join(tmpdir(), "voice-whisper-"));
    try {
      const wav = join(dir, "audio.wav");
      await toWav(audioPath, wav);
      try {
        return z
          .object({
            text: z.string().trim().min(1).max(4000),
            language: z.string().optional(),
            durationMs: z.number().optional(),
          })
          .parse(await this.transcribeWav(wav));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error(this.options.label + " не установлен");
        throw new Error(
          this.options.label + ": " +
            (e instanceof Error ? e.message : "ошибка распознавания") +
            ". Проверьте установку STT и локальный кэш модели.",
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
export class LocalWhisperProvider extends LocalPythonSttProvider {
  constructor(options: { python: string; model: string; language: string }) {
    super({ ...options, script: "scripts/transcribe.py", label: "Whisper" });
  }
}
export class LocalParakeetProvider extends LocalPythonSttProvider {
  private worker?: ChildProcessWithoutNullStreams;
  private ready: Promise<void>;
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  constructor(options: { python: string; model: string }) {
    super({
      ...options,
      script: "scripts/transcribe-parakeet.py",
      label: "NVIDIA Parakeet",
      timeout: 90000,
    });
    this.ready = this.startWorker();
  }
  private startWorker() {
    return new Promise<void>((resolveReady, rejectReady) => {
      const worker = spawn(
        resolve(this.options.python),
        [resolve(this.options.script), "--serve", "--model", this.options.model],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, HF_HUB_OFFLINE: "1" },
        },
      );
      this.worker = worker;
      createInterface({ input: worker.stdout }).on("line", (line) => {
        try {
          const message = JSON.parse(line) as {
            id?: string;
            ready?: boolean;
            error?: string;
            [key: string]: unknown;
          };
          if (message.ready) return resolveReady();
          if (!message.id) return;
          const waiter = this.pending.get(message.id);
          if (!waiter) return;
          this.pending.delete(message.id);
          if (message.error) waiter.reject(new Error(message.error));
          else waiter.resolve(message);
        } catch {
          // Ignore library progress that is not a worker JSON message.
        }
      });
      worker.once("error", rejectReady);
      worker.once("exit", () => {
        const error = new Error("Процесс NVIDIA Parakeet остановился");
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
      });
    });
  }
  protected override async transcribeWav(wav: string) {
    await this.ready;
    const id = randomUUID();
    return new Promise<unknown>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResult(new Error("NVIDIA Parakeet превысил таймаут"));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveResult(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectResult(error);
        },
      });
      this.worker?.stdin.write(JSON.stringify({ id, audio: wav }) + "\n");
    });
  }
}
