import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Agent version string.
 * SEA/CJS: replaced at build by tsup `define` (__DAUYS_AGENT_VERSION__).
 * Dev (tsx/ESM): falls back to env, then root package.json via cwd.
 */
declare const __DAUYS_AGENT_VERSION__: string | undefined;

function readPackageVersionFromCwd(): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { version?: string };
    return typeof pkg.version === "string" && pkg.version
      ? pkg.version
      : undefined;
  } catch {
    return undefined;
  }
}

export function resolveAgentVersion(): string {
  // typeof is safe when the identifier was never declared (dev without define).
  if (typeof __DAUYS_AGENT_VERSION__ === "string" && __DAUYS_AGENT_VERSION__)
    return __DAUYS_AGENT_VERSION__;
  if (process.env.DAUYS_AGENT_VERSION?.trim())
    return process.env.DAUYS_AGENT_VERSION.trim();
  return readPackageVersionFromCwd() ?? "0.1.0";
}

export const AGENT_VERSION = resolveAgentVersion();
