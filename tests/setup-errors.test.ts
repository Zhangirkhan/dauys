import { describe, expect, it } from "vitest";
import { friendlySetupError } from "../apps/mac-agent/src/windows/setup-errors.js";

describe("friendlySetupError", () => {
  it("maps empty bootstrap zod text to Russian", () => {
    expect(
      friendlySetupError("bootstrap: String must contain at least 1 character(s)"),
    ).toMatch(/bootstrap-секрет/i);
  });

  it("maps unauthorized bootstrap", () => {
    expect(friendlySetupError("Требуется bootstrap-секрет агента")).toMatch(
      /Неверный bootstrap/i,
    );
  });

  it("does not dump JSON-looking zod payloads", () => {
    const msg = friendlySetupError('[{"code":"too_small","path":["bootstrap"]}]');
    expect(msg).not.toMatch(/too_small/);
    expect(msg.length).toBeLessThan(200);
  });
});
