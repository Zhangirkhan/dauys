import { describe, expect, it } from "vitest";
import {
  buildNamedSpotlightQuery,
  expandSpokenNumbers,
  levenshtein,
  pickNamedMatch,
  rankNamedMatches,
  scoreNamedPath,
  scoreSpokenLabel,
  spokenNameVariants,
} from "../apps/mac-agent/src/spoken-name.js";

describe("spoken name matching", () => {
  it("turns number words into digits, including whisper typos", () => {
    expect(expandSpokenNumbers("папка один")).toBe("папка 1");
    expect(expandSpokenNumbers("адин")).toBe("1");
    expect(expandSpokenNumbers("папка 01")).toBe("папка 1");
  });

  it("builds token-AND spotlight queries for short numbered folder names", () => {
    const q = buildNamedSpotlightQuery("один", "folder");
    expect(q).toContain("папка");
    expect(q).toContain("*1*");
    expect(q).toMatch(/&&/);
  });

  it("ranks «папка 1» above «папка 11» for spoken «один»", () => {
    expect(
      rankNamedMatches(
        [
          "/Users/me/Documents/папка 11",
          "/Users/me/Desktop/папка 1",
          "/Users/me/Library/Caches/папка 1",
        ],
        "один",
        "folder",
      )[0],
    ).toBe("/Users/me/Desktop/папка 1");
  });

  it("matches hyphen and underscore names to spoken tokens", () => {
    expect(
      scoreNamedPath("/Users/me/Desktop/папка_1", "папка один", "folder"),
    ).toBeGreaterThan(
      scoreNamedPath("/Users/me/Desktop/прочее", "папка один", "folder"),
    );
  });

  it("matches a latin Energy Plus spreadsheet to spoken «энерджи плюс»", () => {
    expect(spokenNameVariants("энерджи плюс", "file")).toEqual(
      expect.arrayContaining(["energy plus"]),
    );
    expect(
      scoreNamedPath(
        "/Users/me/Desktop/таблица Energy plus.xlsx",
        "энерджи плюс",
        "file",
      ),
    ).toBeGreaterThan(200);
    expect(
      pickNamedMatch(
        ["/Users/me/Desktop/таблица Energy plus.xlsx"],
        "energy plus",
        "file",
      ),
    ).toEqual({
      type: "open",
      path: "/Users/me/Desktop/таблица Energy plus.xlsx",
    });
  });

  it("matches any extension, not only documents", () => {
    expect(
      pickNamedMatch(
        ["/Users/me/Downloads/архив.zip", "/Users/me/Downloads/другое.txt"],
        "архив",
        "file",
      ),
    ).toEqual({ type: "open", path: "/Users/me/Downloads/архив.zip" });
  });

  it("asks when two folders are equally close", () => {
    const pick = pickNamedMatch(
      [
        "/Users/me/Desktop/отчет",
        "/Users/me/Documents/отчет",
      ],
      "отчет",
      "folder",
    );
    expect(pick.type).toBe("choose");
    if (pick.type === "choose") expect(pick.paths).toHaveLength(2);
  });

  it("does not treat «папка 11» as a hit for «один»", () => {
    expect(
      pickNamedMatch(
        ["/Users/me/Desktop/папка 11"],
        "один",
        "folder",
      ).type,
    ).toBe("none");
  });

  it("includes kind prefixes in variants", () => {
    expect(spokenNameVariants("один", "folder")).toEqual(
      expect.arrayContaining(["1", "папка 1", "один"]),
    );
  });

  it("computes small edit distance for whisper slips", () => {
    expect(levenshtein("один", "адин")).toBe(1);
  });

  it("scores a spoken dotted label by its leading segment", () => {
    expect(scoreSpokenLabel("cargo.esl.kz", "карго")).toBeGreaterThan(700);
    expect(scoreSpokenLabel("cargo.esl.kz", "кз")).toBeLessThan(700);
    expect(scoreSpokenLabel("projects.100k.kz", "проджектс")).toBeGreaterThan(
      700,
    );
    expect(scoreSpokenLabel("dauys.esl.kz", "рефанд")).toBe(0);
  });

  it("does not confuse a folder name with a project label scorer", () => {
    expect(scoreSpokenLabel("папка 1", "один")).toBeGreaterThan(700);
  });
});
