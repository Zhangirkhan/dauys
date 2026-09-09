import "dotenv/config";
import { createApp } from "./app.js";
import { Store, RegistryFile } from "./store.js";
import { DeepSeekResolver, HybridIntentResolver, MockIntentResolver } from "./intent.js";
import { LocalIntentResolver } from "./local-intent.js";
import {
  HttpWhisperProvider,
  LocalParakeetProvider,
  LocalWhisperProvider,
  MockSpeechToTextProvider,
} from "./stt.js";
const env = process.env;
const intentProvider = (env.INTENT_PROVIDER ?? "mock").trim();
const sttProvider = (env.STT_PROVIDER ?? "mock").trim();
if (!env.AGENT_BOOTSTRAP_SECRET || env.AGENT_BOOTSTRAP_SECRET.length < 32)
  throw new Error(
    "Сначала запустите pnpm setup:env: нужен AGENT_BOOTSTRAP_SECRET длиной не менее 32 символов.",
  );
if (!["mock", "local", "deepseek"].includes(intentProvider))
  throw new Error("INTENT_PROVIDER: mock, local или deepseek");
if (!["mock", "local", "parakeet", "whisper"].includes(sttProvider))
  throw new Error("STT_PROVIDER: mock, local, parakeet или whisper");
const store = new Store(env.DATABASE_URL ?? "./data/assistant.db");
const app = await createApp({
  store,
  registry: new RegistryFile(env.REGISTRY_PATH ?? "./data/registry.json"),
  resolver:
    intentProvider === "deepseek"
      ? new HybridIntentResolver(
          new LocalIntentResolver(),
          new DeepSeekResolver({
            key: env.DEEPSEEK_API_KEY,
            baseURL: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
            model: env.DEEPSEEK_MODEL,
          }),
        )
      : intentProvider === "local"
        ? new LocalIntentResolver()
        : new MockIntentResolver(),
  stt:
    sttProvider === "whisper"
      ? new HttpWhisperProvider({
          url: env.WHISPER_URL ?? "http://127.0.0.1:9000",
          language: env.WHISPER_LANGUAGE ?? "ru",
        })
      : sttProvider === "parakeet"
      ? new LocalParakeetProvider({
          python: env.PARAKEET_PYTHON ?? "./.venv/bin/python",
          model: env.PARAKEET_MODEL ?? "nvidia/parakeet-tdt-0.6b-v3",
        })
      : sttProvider === "local"
      ? new LocalWhisperProvider({
          python: env.WHISPER_PYTHON ?? "./.venv/bin/python",
          model: env.WHISPER_MODEL ?? "small",
          language: env.WHISPER_LANGUAGE ?? "ru",
        })
      : new MockSpeechToTextProvider(env.MOCK_TRANSCRIPT),
  bootstrapSecret: env.AGENT_BOOTSTRAP_SECRET,
  origins: [
    ...(env.PWA_ORIGIN ?? "http://localhost:5173").split(","),
    env.SERVER_PUBLIC_URL ?? "http://localhost:8787",
  ],
  secureCookie: env.COOKIE_SECURE === "true",
  runtime: {
    stt: sttProvider,
    intent: intentProvider,
  },
  logger: true,
  staticDir: "apps/pwa/dist",
});
await app.listen({
  host: env.HOST ?? "127.0.0.1",
  port: Number(env.PORT ?? 8787),
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
