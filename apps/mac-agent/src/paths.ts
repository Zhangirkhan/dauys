import { homedir } from "node:os";
import { join } from "node:path";
import { isSea } from "node:sea";

export function isStandalone() {
  return (
    process.env.DAUYS_STANDALONE === "true" ||
    isSea() ||
    /dauys-agent$/i.test(process.execPath)
  );
}

export function agentDataDir() {
  if (process.env.AGENT_DATA_DIR) return process.env.AGENT_DATA_DIR;
  if (isStandalone())
    return join(homedir(), "Library/Application Support/DauysAgent");
  return join(process.cwd(), "data");
}

export function defaultServerUrl() {
  return isStandalone() ? "https://dauys.esl.kz" : "http://localhost:8787";
}

export function defaultAllowedDirectories() {
  return isStandalone() ? [homedir()] : [];
}

export function defaultRealActions() {
  if (process.env.ALLOW_REAL_MAC_ACTIONS === "true") return true;
  if (process.env.ALLOW_REAL_MAC_ACTIONS === "false") return false;
  return isStandalone();
}
