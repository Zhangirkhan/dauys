import { describe, expect, it } from "vitest";
import {
  compileDriveQuery,
  extractSpokenDrive,
} from "../packages/shared/src/index.js";

describe("spoken drive queries", () => {
  it("compiles name, type and recency into Drive operators", () => {
    expect(compileDriveQuery("открой с диска договор каспи")).toBe(
      "договор каспи",
    );
    expect(compileDriveQuery("найди на диске презентацию про отп за неделю")).toBe(
      "тип:презентация after:7d про отп",
    );
    expect(compileDriveQuery("последний pdf с диска")).toContain("тип:pdf");
    expect(compileDriveQuery("последний pdf с диска")).toContain("after:14d");
  });

  it("only treats explicit disk phrases as drive requests", () => {
    expect(extractSpokenDrive("Открой договор")).toBeUndefined();
    expect(extractSpokenDrive("Найди на диске договор")?.query).toBe("договор");
    expect(extractSpokenDrive("Покажи с диска")?.query).toBe("");
  });
});
