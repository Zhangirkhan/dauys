import { describe, expect, it } from "vitest";
import {
  isBlockedApp,
  pickInstalledApp,
  scoreInstalledApp,
  type InstalledApp,
} from "../apps/mac-agent/src/installed-apps.js";

const apps: InstalledApp[] = [
  {
    name: "Calculator",
    path: "/System/Applications/Calculator.app",
    aliases: ["калькулятор"],
  },
  {
    name: "Notes",
    path: "/System/Applications/Notes.app",
    aliases: ["заметки"],
  },
  {
    name: "Google Chrome",
    path: "/Applications/Google Chrome.app",
    aliases: ["хром"],
  },
  {
    name: "Terminal",
    path: "/System/Applications/Utilities/Terminal.app",
    aliases: [],
  },
  {
    name: "WhatsApp",
    path: "/Applications/WhatsApp.app",
    aliases: ["ватсап", "ватсапп", "вотсап", "вацап"],
  },
  {
    name: "Microsoft Excel",
    path: "/Applications/Microsoft Excel.app",
    aliases: [
      "эксель",
      "эксел",
      "аксель",
      "акцел",
      "excel",
      "майкрософт эксель",
    ],
  },
  {
    name: "Microsoft Word",
    path: "/Applications/Microsoft Word.app",
    aliases: ["ворд", "ворде", "word", "майкрософт ворд"],
  },
];

describe("installed Mac apps", () => {
  it("matches spoken Russian names to system apps", () => {
    expect(pickInstalledApp(apps, "калькулятор")).toEqual({
      type: "open",
      app: apps[0],
    });
    expect(pickInstalledApp(apps, "заметки").type).toBe("open");
    expect(scoreInstalledApp(apps[0], "калькулятор")).toBeGreaterThan(500);
  });

  it("refuses shells and helpers", () => {
    expect(isBlockedApp("Terminal")).toBe(true);
    expect(isBlockedApp("iTerm")).toBe(true);
    expect(pickInstalledApp(apps, "терминал").type).toBe("none");
  });

  it("matches spoken WhatsApp names", () => {
    const whatsapp = apps.find((app) => app.name === "WhatsApp")!;
    for (const query of ["ватсап", "ватсапп", "вацап", "whatsapp", "вотсап"]) {
      expect(pickInstalledApp(apps, query)).toEqual({
        type: "open",
        app: whatsapp,
      });
    }
    expect(scoreInstalledApp(whatsapp, "ватсап")).toBeGreaterThan(500);
  });

  it("matches spoken Word and Excel names", () => {
    const excel = apps.find((app) => app.name === "Microsoft Excel")!;
    const word = apps.find((app) => app.name === "Microsoft Word")!;
    for (const query of ["эксель", "excel", "аксель"]) {
      expect(pickInstalledApp(apps, query)).toEqual({ type: "open", app: excel });
    }
    for (const query of ["ворд", "word"]) {
      expect(pickInstalledApp(apps, query)).toEqual({ type: "open", app: word });
    }
    expect(pickInstalledApp(apps, "калькулятор")).toEqual({
      type: "open",
      app: apps[0],
    });
  });
});
