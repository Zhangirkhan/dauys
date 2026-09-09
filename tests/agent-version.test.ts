import { describe, expect, it } from "vitest";
import { resolveAgentVersion } from "../apps/mac-agent/src/agent-version.js";

describe("agent version resolve", () => {
  it("returns a non-empty version without import.meta", () => {
    const v = resolveAgentVersion();
    expect(v.length).toBeGreaterThan(0);
    expect(v).toMatch(/^\d+\.\d+/);
  });

  it("prefers DAUYS_AGENT_VERSION env when set", () => {
    const prev = process.env.DAUYS_AGENT_VERSION;
    process.env.DAUYS_AGENT_VERSION = "8.8.8-env";
    try {
      expect(resolveAgentVersion()).toBe("8.8.8-env");
    } finally {
      if (prev === undefined) delete process.env.DAUYS_AGENT_VERSION;
      else process.env.DAUYS_AGENT_VERSION = prev;
    }
  });
});
