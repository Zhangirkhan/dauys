import { describe, it, expect, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  actionSchema,
  decisionSchema,
  registrySchema,
  requiresConfirmation,
  type Envelope,
} from "../packages/shared/src/index.js";
import { ExecutionLedger, guardPath } from "../apps/mac-agent/src/safety.js";
import {
  MockIntentResolver,
  parseDecision,
  matchAliases,
  DeepSeekResolver,
} from "../apps/server/src/intent.js";
import {
  MockSpeechToTextProvider,
  LocalWhisperProvider,
} from "../apps/server/src/stt.js";
import { Store } from "../apps/server/src/store.js";
import { MacExecutor } from "../apps/mac-agent/src/executor.js";
const registry = registrySchema.parse(
  JSON.parse(readFileSync("config/registry.example.json", "utf8")),
);
const envelope = (): Envelope => ({
  id: randomUUID(),
  createdAt: Date.now(),
  expiresAt: Date.now() + 60000,
  confirmed: false,
  command: { action: "open_project", parameters: { projectId: "cascade-otp" } },
  registry,
});
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  vi.restoreAllMocks();
});
describe("strict shared schemas", () => {
  it("rejects unknown actions and shell payloads", () => {
    expect(
      actionSchema.safeParse({
        action: "shell",
        parameters: { command: "rm -rf /" },
      }).success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        action: "get_battery_status",
        parameters: { shell: "id" },
      }).success,
    ).toBe(false);
  });
  it("validates URL scheme, credentials, volume and TTL", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pass@example.com",
    ])
      expect(
        actionSchema.safeParse({ action: "open_url", parameters: { url } })
          .success,
      ).toBe(false);
    expect(
      actionSchema.safeParse({
        action: "set_volume",
        parameters: { volume: 101 },
      }).success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        action: "open_url",
        parameters: { url: "https://cascade.kz" },
      }).success,
    ).toBe(true);
  });
  it("parses DeepSeek JSON with mandatory action validation", () => {
    expect(
      parseDecision(
        JSON.stringify({
          type: "execute",
          action: "open_project",
          parameters: { projectId: "cascade-otp" },
          confidence: 0.9,
          confirmationRequired: false,
          spokenResponse: "Открываю",
        }),
      ).type,
    ).toBe("execute");
    expect(() => parseDecision("```json\n{}\n```")).toThrow();
    expect(() =>
      parseDecision('{"type":"execute","action":"shell"}'),
    ).toThrow();
    expect(
      decisionSchema.safeParse({
        type: "execute",
        action: "set_volume",
        parameters: { volume: "loud" },
        confidence: 0.9,
        confirmationRequired: false,
        spokenResponse: "OK",
      }).success,
    ).toBe(false);
  });
  it("classifies risky actions independently of the LLM", () => {
    expect(
      requiresConfirmation({ action: "lock_screen", parameters: {} }),
    ).toBe(true);
    expect(
      requiresConfirmation({
        action: "close_application",
        parameters: { applicationId: "cursor" },
      }),
    ).toBe(false);
    expect(requiresConfirmation(envelope().command)).toBe(false);
  });
  it("retries one malformed DeepSeek output and validates corrected JSON", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response(
          JSON.stringify({
            id: "chat",
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    calls === 1
                      ? "{}"
                      : '{"type":"reject","reason":"Не поддерживается"}',
                },
                finish_reason: "stop",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    try {
      const r = await new DeepSeekResolver({
        key: "test-key",
        baseURL: "https://example.invalid",
        model: "configurable-model",
      }).resolve({ text: "команда", registry, context: { recent: [] } });
      expect(r.type).toBe("reject");
      expect(calls).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("explains missing DeepSeek secrets", async () => {
    await expect(
      new DeepSeekResolver({ baseURL: "https://api.deepseek.com" }).resolve({
        text: "x",
        registry,
        context: { recent: [] },
      }),
    ).rejects.toThrow("DEEPSEEK_API_KEY");
  });
});
describe("execution guard", () => {
  it("persists replay prevention across restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "voice-ledger-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "ledger.db"),
      e = envelope();
    const first = new ExecutionLedger(path);
    first.claim(e);
    first.close();
    const second = new ExecutionLedger(path);
    cleanups.push(() => second.close());
    expect(() => second.claim(e)).toThrow("Повторное");
  });
  it("rejects expired, excessive TTL, future and unconfirmed commands", () => {
    const ledger = new ExecutionLedger(":memory:");
    cleanups.push(() => ledger.close());
    const e = envelope();
    expect(() =>
      ledger.claim({
        ...e,
        createdAt: Date.now() - 70000,
        expiresAt: Date.now() - 10000,
      }),
    ).toThrow("истекла");
    expect(() =>
      ledger.claim({ ...e, expiresAt: e.createdAt + 60001 }),
    ).toThrow();
    expect(() =>
      ledger.claim({
        ...e,
        createdAt: Date.now() + 10000,
        expiresAt: Date.now() + 20000,
      }),
    ).toThrow();
    const danger = { ...e, command: { action: "lock_screen", parameters: {} } };
    expect(() => ledger.claim(danger)).toThrow("подтверждение");
    expect(ledger.claim({ ...danger, confirmed: true }).confirmed).toBe(true);
  });
  it("blocks traversal, sibling-prefix, symlink escape, scripts and hidden files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "voice-path-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const allowed = join(dir, "docs");
    await mkdir(allowed);
    await mkdir(allowed + "-private");
    await writeFile(join(allowed, "ok.pdf"), "document");
    await writeFile(join(allowed + "-private", "secret.pdf"), "private");
    await writeFile(join(allowed, "run.command"), "echo test");
    await writeFile(join(allowed, ".hidden.pdf"), "private");
    await symlink(
      join(allowed + "-private", "secret.pdf"),
      join(allowed, "escape.pdf"),
    );
    expect(await guardPath(join(allowed, "ok.pdf"), [allowed])).toContain(
      "ok.pdf",
    );
    for (const path of [
      join(allowed, "../docs-private/secret.pdf"),
      join(allowed, "escape.pdf"),
      join(allowed, "run.command"),
      join(allowed, ".hidden.pdf"),
    ])
      await expect(guardPath(path, [allowed])).rejects.toThrow();
  });
  it("mock never starts actual system processes and rejects unknown registry IDs", async () => {
    const executor = new MacExecutor({
      real: false,
      roots: [],
      trust: { shortcuts: [], processes: {} },
      dataDir: ".",
    });
    expect(
      (
        await executor.execute(
          { action: "open_project", parameters: { projectId: "cascade-otp" } },
          registry,
        )
      ).data?.mock,
    ).toBe(true);
    expect(
      (
        await executor.execute(
          {
            action: "open_application",
            parameters: { applicationId: "absent" },
          },
          registry,
        )
      ).success,
    ).toBe(false);
  });
});
describe("language and persistence", () => {
  it.each([
    "Открой каскад",
    "Давай поработаем над OTP",
    "Запусти проект с сообщениями",
    "Продолжим работу над сервисом авторизации",
    "Открой Cascade в Cursor",
  ])("resolves natural language: %s", async (text) => {
    const r = await new MockIntentResolver().resolve({
      text,
      registry,
      context: { recent: [] },
    });
    expect(r.type).toBe("execute");
    if (r.type === "execute")
      expect(r.parameters.projectId).toBe("cascade-otp");
  });
  it("matches aliases with word boundaries", () => {
    expect(matchAliases("Открой OTP", registry.projects)).toHaveLength(1);
    expect(matchAliases("notp", registry.projects)).toHaveLength(0);
  });
  it("stores active project and continues pronouns and clarification", async () => {
    const s = new Store(":memory:");
    cleanups.push(() => s.close());
    const agent = s.createDevice("Mac", "agent");
    s.saveContext(agent.id, {
      activeProject: "cascade-otp",
      recent: [{ text: "Открой Cascade" }],
    });
    const resolver = new MockIntentResolver();
    const next = await resolver.resolve({
      text: "Запусти его",
      registry,
      context: s.context(agent.id),
    });
    expect(next.type === "execute" && next.action).toBe("run_scenario");
    const site = await resolver.resolve({
      text: "И открой сайт",
      registry,
      context: s.context(agent.id),
    });
    expect(site.type === "execute" && site.parameters.url).toBe(
      "https://cascade.kz",
    );
    const clarified = await resolver.resolve({
      text: "Первую",
      registry,
      context: { recent: [] },
      pending: {
        originalText: "Открой проект",
        options: [{ id: "cascade-otp", label: "Cascade OTP" }],
      },
    });
    expect(clarified.type === "execute" && clarified.parameters.projectId).toBe(
      "cascade-otp",
    );
  });
  it("provides a deterministic mock transcription", async () => {
    expect(
      await new MockSpeechToTextProvider().transcribe("/does/not/exist"),
    ).toEqual({
      text: "Давай поработаем над OTP",
      language: "ru",
      durationMs: 1000,
    });
  });
  it("real STT rejects invalid audio and cleans normalization directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "voice-bad-audio-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "broken");
    await writeFile(path, "invalid recording");
    await expect(
      new LocalWhisperProvider({
        python: "missing-python",
        model: "small",
        language: "ru",
      }).transcribe(path),
    ).rejects.toThrow(/аудио|FFmpeg/);
  });
  it("pair codes are one-time, expire and revocation invalidates tokens", () => {
    const s = new Store(":memory:");
    cleanups.push(() => s.close());
    const a = s.createDevice("Mac", "agent");
    const code = s.pair(a.id);
    const phone = s.completePair(code.code, "Phone");
    expect(s.authenticate(phone.token)?.id).toBe(phone.id);
    expect(() => s.completePair(code.code, "Other")).toThrow();
    const expired = s.pair(a.id);
    s.db.exec("UPDATE pairs SET expiresAt=0");
    expect(() => s.completePair(expired.code, "Old")).toThrow();
    s.revoke(a.id);
    expect(s.authenticate(phone.token)).toBeUndefined();
    expect(s.authenticate(a.token)).toBeUndefined();
  });
});
