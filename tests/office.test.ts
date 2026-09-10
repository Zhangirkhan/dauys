import { describe, expect, it } from "vitest";
import { emptyOfficeDocument } from "../apps/mac-agent/src/office-files.js";
import {
  extractCloseOffice,
  extractNewOfficeDocument,
  officeKindForExtension,
  spokenOfficeKind,
} from "../packages/shared/src/index.js";

describe("spoken Word and Excel", () => {
  it("detects the office app only when Word or Excel is named", () => {
    expect(spokenOfficeKind("открой эксель")).toBe("excel");
    expect(spokenOfficeKind("открой ворд")).toBe("word");
    expect(spokenOfficeKind("открой telegram")).toBeUndefined();
    expect(spokenOfficeKind("открой курсор")).toBeUndefined();
  });

  it("creates a new document only for explicit Word/Excel phrases", () => {
    expect(extractNewOfficeDocument("создай новый эксель")).toEqual({
      kind: "excel",
    });
    expect(extractNewOfficeDocument("открой новый ворд")).toEqual({
      kind: "word",
    });
    expect(extractNewOfficeDocument("создай новый эксель смету")).toEqual({
      kind: "excel",
      title: "смету",
    });
    expect(
      extractNewOfficeDocument("открой новый проект в курсоре"),
    ).toBeUndefined();
    expect(extractNewOfficeDocument("открой эксель")).toBeUndefined();
    expect(
      extractNewOfficeDocument("открой эксель таблицу энерджи плюс"),
    ).toBeUndefined();
  });

  it("closes the app or only the current document", () => {
    expect(extractCloseOffice("закрой эксель")).toEqual({
      kind: "excel",
      documentOnly: false,
    });
    expect(extractCloseOffice("закрой документ в ворде")).toEqual({
      kind: "word",
      documentOnly: true,
    });
    expect(extractCloseOffice("закрой заметки")).toBeUndefined();
  });

  it("maps Word/Excel extensions and ignores others", () => {
    expect(officeKindForExtension("xlsx")).toBe("excel");
    expect(officeKindForExtension(".docx")).toBe("word");
    expect(officeKindForExtension("pdf")).toBeUndefined();
    expect(officeKindForExtension("pptx")).toBeUndefined();
    expect(officeKindForExtension("csv")).toBeUndefined();
  });

  it("builds a zip Word/Excel template", () => {
    const xlsx = emptyOfficeDocument("excel");
    const docx = emptyOfficeDocument("word");
    expect(xlsx.subarray(0, 2).toString()).toBe("PK");
    expect(docx.subarray(0, 2).toString()).toBe("PK");
    expect(xlsx.length).toBeGreaterThan(200);
    expect(docx.length).toBeGreaterThan(200);
  });
});
