import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { registrySchema, type Context } from "../packages/shared/src/index.js";
import {
  LocalIntentResolver,
  localMatches,
} from "../apps/server/src/local-intent.js";
import {
  extractSpokenItem,
  preferSpokenNamedItem,
} from "../apps/server/src/named-item.js";
import { execute } from "../apps/server/src/intent.js";
import {
  knownFolderPath,
  rankNamedMatches,
} from "../apps/mac-agent/src/executor.js";
const registry = registrySchema.parse(
  JSON.parse(readFileSync("config/registry.example.json", "utf8")),
);
registry.applications
  .find((a) => a.id === "telegram")!
  .aliases.push("телеграм", "телеграмму");
registry.applications.find((a) => a.id === "cursor")!.aliases.push("курсоре");
const resolver = new LocalIntentResolver();
const context: Context = {
  activeProject: "cascade-otp",
  lastApplication: "cursor",
  recent: [{ text: "Открой Cascade", action: "open_project" }],
};
describe("real local intent without cloud keys", () => {
  it.each([
    "Открой Telegram",
    "Запусти телеграм",
    "Открой телеграмму пожалуйста",
  ])(
    "opens the explicitly named app after an earlier project: %s",
    async (text) => {
      const d = await resolver.resolve({ text, registry, context });
      expect(d.type === "execute" && d.action).toBe("open_application");
      expect(d.type === "execute" && d.parameters.applicationId).toBe(
        "telegram",
      );
    },
  );
  it("opens a named project in Cursor without running a process", async () => {
    const d = await resolver.resolve({
      text: "Запусти Cascade в курсоре",
      registry,
      context: { recent: [] },
    });
    expect(d.type === "execute" && d.action).toBe("open_project");
    expect(d.type === "execute" && d.parameters).toEqual({
      projectId: "cascade-otp",
      applicationId: "cursor",
    });
  });
  it("focuses Cursor without opening another copy of the current project", async () => {
    const d = await resolver.resolve({
      text: "Открой курсор",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_application");
    expect(d.type === "execute" && d.parameters).toEqual({
      applicationId: "cursor",
    });
  });
  it("opens a blank Cursor window for a new project", async () => {
    const d = await resolver.resolve({
      text: "Открой новый проект в курсоре",
      registry,
      context,
    });
    expect(d.type === "execute" && d.parameters).toEqual({
      applicationId: "cursor",
      newWindow: true,
    });
  });
  it("opens Word and Excel as apps, not as file search", async () => {
    for (const [text, query] of [
      ["Открой эксель", "эксель"],
      ["Открой ворд", "ворд"],
      ["Открой excel", "excel"],
    ] as const) {
      const d = await resolver.resolve({ text, registry, context });
      expect(d.type === "execute" && d.action).toBe("open_application");
      expect(d.type === "execute" && d.parameters).toEqual({ query });
    }
  });
  it("creates a new Excel or Word document instead of a Cursor window", async () => {
    const excel = await resolver.resolve({
      text: "Создай новый эксель",
      registry,
      context,
    });
    expect(excel.type === "execute" && excel.parameters).toEqual({
      query: "excel",
      newDocument: true,
    });
    const word = await resolver.resolve({
      text: "Открой новый ворд",
      registry,
      context,
    });
    expect(word.type === "execute" && word.parameters).toEqual({
      query: "word",
      newDocument: true,
    });
  });
  it("closes Excel/Word or only the current document", async () => {
    const excel = await resolver.resolve({
      text: "Закрой эксель",
      registry,
      context,
    });
    expect(excel.type === "execute" && excel.parameters).toEqual({
      query: "excel",
    });
    const doc = await resolver.resolve({
      text: "Закрой документ в ворде",
      registry,
      context,
    });
    expect(doc.type === "execute" && doc.parameters).toEqual({
      query: "word",
      documentOnly: true,
    });
  });
  it("still searches a named spreadsheet instead of launching Excel", async () => {
    const d = await resolver.resolve({
      text: "Открой эксель таблицу энерджи плюс",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_named_item");
    expect(d.type === "execute" && d.parameters).toEqual({
      query: "энерджи плюс",
      kind: "file",
    });
  });
  it("searches for an unnamed spoken project instead of reusing the active one", async () => {
    const d = await resolver.resolve({
      text: "Открой неизвестный проект в курсоре",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_editor_project");
    expect(d.type === "execute" && d.parameters).toEqual({
      query: "неизвестный",
      applicationId: "cursor",
    });
  });
  it("accepts Whisper changing the imperative to 'открою'", async () => {
    const d = await resolver.resolve({
      text: "Открою в курсоре проект Коскадо",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_editor_project");
    expect(d.type === "execute" && d.parameters.query).toBe("коскадо");
    expect(d.type === "execute" && d.parameters.applicationId).toBe("cursor");
  });
  it("keeps the chosen editor across a project clarification", async () => {
    const d = await resolver.resolve({
      text: "Первый",
      registry,
      context: { recent: [] },
      pending: {
        originalText: "Открой проект в курсоре",
        options: [{ id: "project:cascade-otp", label: "Cascade" }],
      },
    });
    expect(d.type === "execute" && d.parameters).toEqual({
      projectId: "cascade-otp",
      applicationId: "cursor",
    });
  });
  it("prefers compound project names but preserves distinct ambiguous targets", () => {
    const entries = [
      { id: "base", name: "BetGPT", aliases: [] },
      { id: "mobile", name: "BetGPT Mobile", aliases: [] },
    ];
    expect(
      localMatches("Открой BetGPT Mobile", entries).map((p) => p.id),
    ).toEqual(["mobile"]);
    expect(
      localMatches("Открой Telegram и Safari", registry.applications),
    ).toHaveLength(2);
  });
  it("understands a common Whisper distortion of Google Chrome", () => {
    const applications = [
      {
        id: "chrome",
        name: "Google Chrome",
        aliases: ["гугл хром", "голого храма", "голову срама"],
      },
    ];
    expect(localMatches("Открой голого храма", applications)[0]?.id).toBe(
      "chrome",
    );
    expect(localMatches("Открой голову срама", applications)[0]?.id).toBe(
      "chrome",
    );
  });
  it("opens an arbitrary folder by name instead of the active project", async () => {
    const d = await resolver.resolve({
      text: "Открой папку Загрузки",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_named_item");
    expect(d.type === "execute" && d.parameters).toEqual({
      query: "загрузки",
      kind: "folder",
    });
  });
  it("keeps a spoken number as the folder query", async () => {
    const d = await resolver.resolve({
      text: "Открой папку один",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_named_item");
    expect(d.type === "execute" && d.parameters).toEqual({
      query: "один",
      kind: "folder",
    });
  });
  it("searches the corporate drive instead of a local folder", async () => {
    const d = await resolver.resolve({
      text: "Найди на диске договор каспи",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("search_drive");
    expect(d.type === "execute" && d.parameters).toEqual({
      query: "договор каспи",
      open: true,
    });
  });
  it("opens an arbitrary file by name", async () => {
    const d = await resolver.resolve({
      text: "Открой файл отчет",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_named_item");
    expect(d.type === "execute" && d.parameters).toEqual({
      query: "отчет",
      kind: "file",
    });
  });
  it("opens a spoken spreadsheet by name instead of an app", async () => {
    const d = await resolver.resolve({
      text: "Открой эксель таблицу энерджи плюс",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_named_item");
    expect(d.type === "execute" && d.parameters).toEqual({
      query: "энерджи плюс",
      kind: "file",
    });
  });
  it("opens a spoken folder name that is not a registered app or project", async () => {
    const d = await resolver.resolve({
      text: "Открой документы",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_named_item");
    expect(d.type === "execute" && d.parameters.query).toBe("документы");
  });
  it("opens any installed app by spoken name without a registry id", async () => {
    const d = await resolver.resolve({
      text: "Открой калькулятор",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_application");
    expect(d.type === "execute" && d.parameters).toEqual({
      query: "калькулятор",
    });
  });
  it("launches an installed app with запусти", async () => {
    const d = await resolver.resolve({
      text: "Запусти калькулятор",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_application");
    expect(d.type === "execute" && d.parameters).toEqual({
      query: "калькулятор",
    });
  });
  it("closes an installed app by spoken name", async () => {
    const d = await resolver.resolve({
      text: "Закрой заметки",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("close_application");
    expect(d.type === "execute" && d.parameters).toEqual({ query: "заметки" });
  });
  it("opens WhatsApp by spoken Russian names", async () => {
    for (const text of ["Открой ватсап", "Открой ватсапп", "Открой вацап"]) {
      const d = await resolver.resolve({ text, registry, context });
      expect(d.type === "execute" && d.action).toBe("open_application");
      expect(d.type === "execute" && d.parameters).toEqual({
        query: text.replace(/^открой /i, "").toLocaleLowerCase("ru"),
      });
    }
  });
  it("opens the registered project folder only when that project is named", async () => {
    const d = await resolver.resolve({
      text: "Открой папку OTP",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_folder");
    expect(d.type === "execute" && d.parameters.path).toBe(
      "/Users/USERNAME/Projects/cascade",
    );
  });
  it("resolves an app pronoun independently of older project context", async () => {
    const d = await resolver.resolve({
      text: "Открой его",
      registry,
      context: {
        ...context,
        lastApplication: "telegram",
        recent: [{ text: "Открой Telegram", action: "open_application" }],
      },
    });
    expect(d.type === "execute" && d.parameters.applicationId).toBe("telegram");
  });
  it.each([
    "Не открывай Telegram",
    "Как открыть Telegram",
    "Спасибо за просмотр",
    "Удали проект Cascade",
  ])("does not execute noncommands or forbidden requests: %s", async (text) => {
    expect((await resolver.resolve({ text, registry, context })).type).not.toBe(
      "execute",
    );
  });
});

describe("spoken folder and file names", () => {
  it("extracts folder and file queries", () => {
    expect(extractSpokenItem("Открой папку Загрузки")).toEqual({
      query: "загрузки",
      kind: "folder",
    });
    expect(extractSpokenItem("Открой файл отчет")).toEqual({
      query: "отчет",
      kind: "file",
    });
    expect(extractSpokenItem("Открой таблицу energy plus")).toEqual({
      query: "energy plus",
      kind: "file",
    });
    expect(extractSpokenItem("Открой эксель таблицу энерджи плюс")).toEqual({
      query: "энерджи плюс",
      kind: "file",
    });
    expect(extractSpokenItem("Открой акцель таблицу energy plus")).toEqual({
      query: "energy plus",
      kind: "file",
    });
    expect(extractSpokenItem("Открой презентацию")).toBeUndefined();
    expect(extractSpokenItem("Открой последний PDF")).toBeUndefined();
    expect(extractSpokenItem("Открой excel")).toEqual({
      query: "excel",
      kind: "any",
    });
    expect(extractSpokenItem("Открой документы")).toEqual({
      query: "документы",
      kind: "any",
    });
    expect(extractSpokenItem("Открой папку один")).toEqual({
      query: "один",
      kind: "folder",
    });
    expect(extractSpokenItem("Открой папку 1")).toEqual({
      query: "1",
      kind: "folder",
    });
  });
  it("rewrites a bare Cursor request away from the active project", () => {
    const rewritten = preferSpokenNamedItem(
      "Открой курсор",
      registry,
      execute(
        { action: "open_project", parameters: { projectId: "cascade-otp" } },
        "Открываю Cascade",
      ),
    );
    expect(rewritten.type === "execute" && rewritten.parameters).toEqual({
      applicationId: "cursor",
    });
  });
  it("opens a new Cursor window instead of the active project", () => {
    const rewritten = preferSpokenNamedItem(
      "Открой новый проект в курсоре",
      registry,
      execute(
        { action: "open_project", parameters: { projectId: "cascade-otp" } },
        "Открываю Cascade",
      ),
    );
    expect(rewritten.type === "execute" && rewritten.parameters).toEqual({
      applicationId: "cursor",
      newWindow: true,
    });
  });
  it("does not steal a new Excel document into a Cursor window", () => {
    const rewritten = preferSpokenNamedItem(
      "Создай новый эксель",
      registry,
      execute(
        {
          action: "open_application",
          parameters: { applicationId: "cursor", newWindow: true },
        },
        "Открываю новое окно Cursor",
      ),
    );
    expect(rewritten.type === "execute" && rewritten.parameters).toEqual({
      query: "excel",
      newDocument: true,
    });
  });
  it("does not let an active project replace a spoken folder name", () => {
    const rewritten = preferSpokenNamedItem(
      "Открой папку Загрузки",
      registry,
      execute(
        { action: "open_project", parameters: { projectId: "cascade-otp" } },
        "Открываю Cascade",
      ),
    );
    expect(rewritten.type === "execute" && rewritten.action).toBe(
      "open_named_item",
    );
    expect(rewritten.type === "execute" && rewritten.parameters).toEqual({
      query: "загрузки",
      kind: "folder",
    });
  });
  it("maps common Russian folder names to the home directory", () => {
    expect(knownFolderPath("загрузки")).toBe(join(homedir(), "Downloads"));
    expect(knownFolderPath("документы")).toBe(join(homedir(), "Documents"));
    expect(knownFolderPath("рабочий стол")).toBe(join(homedir(), "Desktop"));
  });
  it("ranks an exact folder name above nested project copies", () => {
    expect(
      rankNamedMatches(
        [
          "/Users/me/Library/Caches/Downloads",
          "/Users/me/Developer/betgpt",
          "/Users/me/Downloads",
        ],
        "Downloads",
      )[0],
    ).toBe("/Users/me/Downloads");
  });
});
