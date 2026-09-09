import { describe, expect, it } from "vitest";
import { agentHelloSchema } from "../packages/shared/src/index.js";

describe("agentHelloSchema compat", () => {
  it("accepts legacy Mac hello without platform/supportedActions", () => {
    const hello = agentHelloSchema.parse({
      type: "hello",
      realActions: true,
      shortcuts: [{ id: "s1", name: "Demo" }],
    });
    expect(hello.platform).toBeUndefined();
    expect(hello.supportedActions).toBeUndefined();
    expect(hello.realActions).toBe(true);
  });

  it("accepts Windows hello with platform and supportedActions", () => {
    const hello = agentHelloSchema.parse({
      type: "hello",
      realActions: true,
      shortcuts: [],
      platform: "win32",
      supportedActions: ["open_application", "get_battery_status"],
    });
    expect(hello.platform).toBe("win32");
    expect(hello.supportedActions).toEqual([
      "open_application",
      "get_battery_status",
    ]);
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      agentHelloSchema.parse({
        type: "hello",
        realActions: false,
        shortcuts: [],
        evil: true,
      }),
    ).toThrow(/Unrecognized key/);
  });

  it("rejects invalid platform", () => {
    expect(() =>
      agentHelloSchema.parse({
        type: "hello",
        realActions: false,
        shortcuts: [],
        platform: "android",
      }),
    ).toThrow();
  });

  it("rejects unknown supportedActions", () => {
    expect(() =>
      agentHelloSchema.parse({
        type: "hello",
        realActions: false,
        shortcuts: [],
        supportedActions: ["not_a_real_action"],
      }),
    ).toThrow();
  });
});
