import { afterEach, describe, expect, it } from "vitest";
import {
  agentDataDir,
  defaultAllowedDirectories,
  defaultRealActions,
  defaultServerUrl,
  isStandalone,
} from "../apps/mac-agent/src/paths.js";

const keys = [
  "DAUYS_STANDALONE",
  "AGENT_DATA_DIR",
  "ALLOW_REAL_MAC_ACTIONS",
  "ALLOW_REAL_ACTIONS",
] as const;

const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("standalone agent paths", () => {
  it("uses Application Support when DAUYS_STANDALONE is set", () => {
    process.env.DAUYS_STANDALONE = "true";
    delete process.env.AGENT_DATA_DIR;
    expect(isStandalone()).toBe(true);
    expect(agentDataDir()).toMatch(/Application Support\/DauysAgent$/);
    expect(defaultServerUrl()).toBe("https://dauys.esl.kz");
    expect(defaultAllowedDirectories().length).toBe(1);
    expect(defaultRealActions()).toBe(true);
  });

  it("keeps local data dir in development", () => {
    delete process.env.DAUYS_STANDALONE;
    delete process.env.AGENT_DATA_DIR;
    if (isStandalone()) return;
    expect(agentDataDir()).toMatch(/\/data$/);
    expect(defaultServerUrl()).toBe("http://localhost:8787");
    expect(defaultRealActions()).toBe(false);
  });

  it("honors AGENT_DATA_DIR and ALLOW_REAL_MAC_ACTIONS=false", () => {
    process.env.DAUYS_STANDALONE = "true";
    process.env.AGENT_DATA_DIR = "/tmp/dauys-agent-test";
    process.env.ALLOW_REAL_MAC_ACTIONS = "false";
    delete process.env.ALLOW_REAL_ACTIONS;
    expect(agentDataDir()).toBe("/tmp/dauys-agent-test");
    expect(defaultRealActions()).toBe(false);
  });

  it("prefers ALLOW_REAL_ACTIONS over ALLOW_REAL_MAC_ACTIONS", () => {
    process.env.ALLOW_REAL_MAC_ACTIONS = "false";
    process.env.ALLOW_REAL_ACTIONS = "true";
    expect(defaultRealActions()).toBe(true);
  });
});
