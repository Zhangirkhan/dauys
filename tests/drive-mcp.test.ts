import { describe, expect, it } from "vitest";
import {
  driveOpenUrl,
  fileExtension,
  isOfficeFile,
  parseDriveHit,
} from "../apps/mac-agent/src/drive-mcp.js";

describe("drive office URLs", () => {
  it("opens Word and Excel in the OnlyOffice editor, including name-only extensions", () => {
    expect(
      driveOpenUrl("https://drive.esl.kz", {
        id: 91,
        kind: "file",
        name: "договор.docx",
        path: "/",
      }),
    ).toBe("https://drive.esl.kz/app/office/91");
    expect(
      driveOpenUrl("https://drive.esl.kz", {
        id: 96,
        kind: "file",
        name: "Таблица ESL.xlsx",
        path: "/",
        extension: "xlsx",
      }),
    ).toBe("https://drive.esl.kz/app/office/96");
  });

  it("keeps preview for non-office files and prefers a same-origin open link", () => {
    expect(
      driveOpenUrl("https://drive.esl.kz", {
        id: 7,
        kind: "file",
        name: "clip.mp4",
        path: "/",
        extension: "mp4",
      }),
    ).toBe("https://drive.esl.kz/app/preview/7");
    expect(
      driveOpenUrl("https://drive.esl.kz", {
        id: 3,
        kind: "file",
        name: "a.xlsx",
        path: "/",
        open: "https://drive.esl.kz/app/office/3",
      }),
    ).toBe("https://drive.esl.kz/app/office/3");
  });

  it("detects office types from the filename when MCP omits extension", () => {
    expect(fileExtension({ name: "Отчёт.xlsx" })).toBe("xlsx");
    expect(
      isOfficeFile(
        parseDriveHit({ id: 1, kind: "file", name: "Договор.docx" })!,
      ),
    ).toBe(true);
    expect(
      isOfficeFile({ kind: "file", name: "note.txt", extension: "txt" }),
    ).toBe(false);
  });
});
