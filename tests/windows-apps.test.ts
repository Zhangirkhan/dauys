import { describe, expect, it } from "vitest";
import {
  isUnsafeShortcutTarget,
  isTrustedSystemId,
  TRUSTED_SYSTEM_TARGETS,
} from "../apps/mac-agent/src/windows/validate-exe.js";
import {
  defaultLocalApps,
  catalogForServer,
  mergeDiscovered,
  findLocalApp,
} from "../apps/mac-agent/src/windows/apps-store.js";
import { appsCatalogSchema, localAppsFileSchema } from "../packages/shared/src/index.js";
import type { LocalApp } from "../packages/shared/src/index.js";

describe("validate-exe helpers", () => {
  it("rejects unsafe shortcut targets", () => {
    expect(isUnsafeShortcutTarget("https://evil.example")).toBe(true);
    expect(isUnsafeShortcutTarget("\\\\server\\share\\a.exe")).toBe(true);
    expect(isUnsafeShortcutTarget("C:\\Tools\\run.bat")).toBe(true);
    expect(
      isUnsafeShortcutTarget("C:\\Windows\\System32\\cmd.exe", "/c whoami"),
    ).toBe(true);
    expect(
      isUnsafeShortcutTarget(
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      ),
    ).toBe(false);
  });

  it("exposes trusted system targets", () => {
    expect(isTrustedSystemId("settings")).toBe(true);
    expect(isTrustedSystemId("explorer")).toBe(true);
    expect(isTrustedSystemId("chrome")).toBe(false);
    expect(TRUSTED_SYSTEM_TARGETS.settings.launch).toBe("ms-settings:");
  });
});

describe("local apps catalog", () => {
  it("defaults include system apps without paths", () => {
    const file = defaultLocalApps();
    expect(localAppsFileSchema.parse(file).apps.length).toBeGreaterThanOrEqual(2);
    const catalog = catalogForServer(file.apps);
    expect(catalog.every((a) => !("executable" in a) && !("path" in a))).toBe(
      true,
    );
    expect(appsCatalogSchema.parse({ type: "apps_catalog", applications: catalog }));
  });

  it("merge keeps user enabled flag", () => {
    const current = defaultLocalApps();
    current.apps = current.apps.map((a) =>
      a.id === "settings" ? { ...a, enabled: false } : a,
    );
    const discovered: LocalApp[] = [
      {
        kind: "exe",
        id: "chrome",
        name: "Google Chrome",
        aliases: ["хром"],
        executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        enabled: true,
      },
    ];
    const merged = mergeDiscovered(current, discovered);
    expect(findLocalApp(merged.apps, "settings")?.enabled).toBe(false);
    expect(findLocalApp(merged.apps, "chrome")?.kind).toBe("exe");
  });

  it("apps_catalog schema strips path if attacker adds it at parse boundary", () => {
    const parsed = appsCatalogSchema.parse({
      type: "apps_catalog",
      applications: [
        { id: "telegram", name: "Telegram", aliases: ["телега"] },
      ],
    });
    expect(parsed.applications[0]).toEqual({
      id: "telegram",
      name: "Telegram",
      aliases: ["телега"],
    });
    expect(
      appsCatalogSchema.safeParse({
        type: "apps_catalog",
        applications: [
          {
            id: "x",
            name: "X",
            aliases: [],
            path: "C:\\evil.exe",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
