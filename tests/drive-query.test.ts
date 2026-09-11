import { describe, expect, it } from "vitest";
import {
  compileDriveQuery,
  extractSpokenDrive,
  pickDriveHit,
  driveSearchVariants,
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
    expect(
      extractSpokenDrive("открой файл с диска под названием Anketa")?.query,
    ).toBe("анкета");
    expect(
      extractSpokenDrive("Подкрой файл с диска под названием Logistica")?.query,
    ).toBe("логистика");
    expect(extractSpokenDrive("открой с дискологистику")?.query).toContain(
      "логистику",
    );
    expect(extractSpokenDrive("Покажи с диска")?.query).toBe("");
    expect(extractSpokenDrive("вытащи отчет коктем с диска")?.query).toBe(
      "отчет коктем",
    );
    expect(extractSpokenDrive("вытащи отчет коктем")).toBeUndefined();
  });

  it("matches spoken drive names with spaces to underscored files", () => {
    expect(driveSearchVariants("контакты алматы")).toContain("контакты_алматы");
    expect(
      pickDriveHit(
        [
          { name: "Контакты_Алматы.txt", kind: "file" },
          { name: "Папка Альфа", kind: "folder" },
        ],
        "контакты алматы",
      )?.name,
    ).toBe("Контакты_Алматы.txt");
    expect(
      pickDriveHit(
        [
          { name: "Отчет_Коктем.txt", kind: "file" },
          { name: "Папка Альфа", kind: "folder" },
          { name: "Папка Бета", kind: "folder" },
        ],
        "отчет к тем о том",
      )?.name,
    ).toBe("Отчет_Коктем.txt");
    expect(
      pickDriveHit([{ name: "Папка Альфа", kind: "folder" }], "отчет к тем о том"),
    ).toBeUndefined();
    expect(
      pickDriveHit(
        [{ name: "Отчет_Годовой.txt", kind: "file" }],
        "отчет к тем о том",
      ),
    ).toBeUndefined();
  });
});
