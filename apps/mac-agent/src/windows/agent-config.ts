import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  agentConfigSchema,
  type AgentConfig,
} from "../../../../packages/shared/src/index.js";
import { defaultServerUrl } from "../paths.js";
import { protectUserFile } from "./protect.js";
import { isSafeAbsolutePath } from "../../../../packages/shared/src/index.js";

export function configPath(dataDir: string) {
  return resolve(dataDir, "agent-config.json");
}

export function defaultAgentConfig(): AgentConfig {
  return {
    serverUrl: defaultServerUrl(),
    allowedDirectories: [],
    setupCompleted: false,
    autostart: true,
  };
}

export async function loadAgentConfig(dataDir: string): Promise<AgentConfig> {
  try {
    return agentConfigSchema.parse(
      JSON.parse(await readFile(configPath(dataDir), "utf8")),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return defaultAgentConfig();
    throw e;
  }
}

export async function saveAgentConfig(
  dataDir: string,
  config: AgentConfig,
  helpersDir?: string,
) {
  const parsed = agentConfigSchema.parse(config);
  for (const d of parsed.allowedDirectories) {
    if (!isSafeAbsolutePath(d))
      throw new Error("Недопустимый каталог: " + d);
  }
  const path = configPath(dataDir);
  await writeFile(path, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  if (helpersDir && process.platform === "win32")
    await protectUserFile(path, helpersDir);
  return parsed;
}
