import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { registrySchema } from "../packages/shared/src/index.js";
import { LocalIntentResolver } from "../apps/server/src/local-intent.js";
import { execute, HybridIntentResolver } from "../apps/server/src/intent.js";
import {
  extractSpokenUrl,
  prepareSpokenWeb,
  preferSpokenUrl,
  transliterateHost,
} from "../apps/server/src/spoken-url.js";
import { extractSpokenItem } from "../apps/server/src/named-item.js";

const registry = registrySchema.parse(
  JSON.parse(readFileSync("config/registry.example.json", "utf8")),
);
const resolver = new LocalIntentResolver();
const context = {
  activeProject: "cascade-otp",
  lastApplication: "cursor",
  recent: [{ text: "Открой Cascade", action: "open_project" as const }],
};

describe("spoken web addresses", () => {
  it("turns spoken TLDs and cyrillic hosts into latin domains", () => {
    expect(prepareSpokenWeb("егов точка кз")).toContain("егов.kz");
    expect(transliterateHost("егов.кз")).toBe("egov.kz");
    expect(extractSpokenUrl("егов.кз")?.url).toBe("https://egov.kz");
    expect(extractSpokenUrl("egov точка кз")?.url).toBe("https://egov.kz");
  });
  it("maps госуслуги and егов to egov.kz in Chrome", () => {
    expect(
      extractSpokenUrl("Открой в хроме сайт егов.кз", registry),
    ).toEqual({
      url: "https://egov.kz",
      applicationId: "chrome",
    });
    expect(extractSpokenUrl("Открой госуслуги в хроме", registry)).toEqual({
      url: "https://egov.kz",
      applicationId: "chrome",
    });
  });
  it("does not treat «открой гугл хром» as google.com", () => {
    expect(extractSpokenUrl("Открой гугл хром", registry)).toBeUndefined();
  });
  it("does not steal a project site command without a domain", () => {
    expect(extractSpokenUrl("И открой сайт")).toBeUndefined();
  });
  it("opens a spoken site instead of the active project", async () => {
    const d = await resolver.resolve({
      text: "Открой в хроме сайт егов.кз",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_url");
    expect(d.type === "execute" && d.parameters).toEqual({
      url: "https://egov.kz",
      applicationId: "chrome",
    });
  });
  it("still opens the registered project site when no domain is spoken", async () => {
    const d = await resolver.resolve({
      text: "Открой сайт",
      registry,
      context,
    });
    expect(d.type === "execute" && d.parameters).toEqual({
      url: "https://cascade.kz",
    });
  });
  it("rewrites a Chrome-only decision into the spoken URL", () => {
    const rewritten = preferSpokenUrl(
      "Открой в хроме егов.кз",
      registry,
      execute(
        { action: "open_application", parameters: { applicationId: "chrome" } },
        "Открываю Chrome",
      ),
    );
    expect(rewritten.type === "execute" && rewritten.parameters).toEqual({
      url: "https://egov.kz",
      applicationId: "chrome",
    });
  });
  it("does not steal a drive file search into a website", () => {
    const rewritten = preferSpokenUrl(
      "Открой с диска файл отчет коктем",
      registry,
      execute(
        {
          action: "search_drive",
          parameters: { query: "отчет коктем", open: true },
        },
        "Ищу на диске: отчет коктем",
      ),
    );
    expect(rewritten.type === "execute" && rewritten.action).toBe("search_drive");
  });
  it("does not treat a spoken site as a folder name", () => {
    expect(extractSpokenItem("Открой в хроме сайт егов.кз")).toBeUndefined();
  });
  it("skips the cloud model when local intent already has an action", async () => {
    let cloudCalls = 0;
    const hybrid = new HybridIntentResolver(resolver, {
      async resolve() {
        cloudCalls += 1;
        return { type: "reject", reason: "cloud" };
      },
    });
    const d = await hybrid.resolve({
      text: "Открой Telegram",
      registry,
      context,
    });
    expect(d.type === "execute" && d.action).toBe("open_application");
    expect(cloudCalls).toBe(0);
  });
});
