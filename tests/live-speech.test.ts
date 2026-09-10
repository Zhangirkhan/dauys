import { describe, expect, it } from "vitest";
import { foldSpeechResults, preferLiveSpeechOnly } from "../apps/pwa/src/live-speech.js";

describe("live speech captions", () => {
  it("shows the latest interim word beside committed finals", () => {
    expect(
      foldSpeechResults([
        { transcript: "открой", isFinal: true },
        { transcript: "ватсап", isFinal: false },
      ]),
    ).toEqual({
      finalText: "открой",
      interimText: "ватсап",
      display: "открой ватсап",
    });
  });

  it("joins several finalized phrases into one command line", () => {
    expect(
      foldSpeechResults([
        { transcript: "открой с диска", isFinal: true },
        { transcript: "логистику", isFinal: true },
      ]).display,
    ).toBe("открой с диска логистику");
  });

  it("uses live speech alone on a real iPhone, but not in Playwright", () => {
    expect(
      preferLiveSpeechOnly({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        platform: "iPhone",
        maxTouchPoints: 5,
        webdriver: false,
      }),
    ).toBe(true);
    expect(
      preferLiveSpeechOnly({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
        platform: "iPhone",
        maxTouchPoints: 5,
        webdriver: true,
      }),
    ).toBe(false);
  });
});
