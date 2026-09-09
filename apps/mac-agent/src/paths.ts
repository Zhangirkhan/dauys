import { join } from "node:path";
import { homedir } from "node:os";
import { isSea } from "node:sea";

export function isStandalone() {
  return (
    process.env.DAUYS_STANDALONE === "true" ||
    isSea() ||
    /dauys-agent(\.exe)?$/i.test(process.execPath)
  );
}

export function agentDataDir() {
  if (process.env.AGENT_DATA_DIR) return process.env.AGENT_DATA_DIR;
  if (isStandalone()) {
    if (process.platform === "win32") {
      const base =
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
      return join(base, "DauysAgent");
    }
    return join(homedir(), "Library/Application Support/DauysAgent");
  }
  return join(process.cwd(), "data");
}

export function defaultServerUrl() {
  return isStandalone() ? "https://dauys.esl.kz" : "http://localhost:8787";
}

export function defaultAllowedDirectories() {
  return isStandalone() ? [homedir()] : [];
}

/** Real OS actions. Prefer ALLOW_REAL_ACTIONS; ALLOW_REAL_MAC_ACTIONS kept for compat. */
export function defaultRealActions() {
  const modern = process.env.ALLOW_REAL_ACTIONS;
  if (modern === "true") return true;
  if (modern === "false") return false;
  if (process.env.ALLOW_REAL_MAC_ACTIONS === "true") return true;
  if (process.env.ALLOW_REAL_MAC_ACTIONS === "false") return false;
  return isStandalone();
}
