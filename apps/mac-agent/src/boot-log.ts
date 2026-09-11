import { writeSync } from "node:fs";
import { basename } from "node:path";

const startedAt = Date.now();
const stageStarted = new Map<string, number>();

function elapsed() {
  return Date.now() - startedAt;
}

/** Sync writes so SEA/minimized consoles flush before later awaits. */
export function bootLog(message: string, extra?: Record<string, unknown>) {
  const suffix =
    extra && Object.keys(extra).length > 0 ? " " + JSON.stringify(extra) : "";
  writeSync(1, `[dauys ${elapsed()}ms] ${message}${suffix}\n`);
}

export function bootErr(message: string, err?: unknown) {
  const detail =
    err === undefined
      ? ""
      : ": " + (err instanceof Error ? err.message : String(err));
  writeSync(2, `[dauys ${elapsed()}ms] ${message}${detail}\n`);
}

export function bootStageStart(name: string, extra?: Record<string, unknown>) {
  stageStarted.set(name, Date.now());
  bootLog("START " + name, extra);
}

export function bootStageDone(name: string, extra?: Record<string, unknown>) {
  const t0 = stageStarted.get(name) ?? Date.now();
  bootLog("DONE " + name, { ms: Date.now() - t0, ...extra });
}

export function bootStageFail(name: string, err: unknown) {
  const t0 = stageStarted.get(name) ?? Date.now();
  bootErr("FAIL " + name + " (" + (Date.now() - t0) + "ms)", err);
}

export function bootProcessBanner(info: {
  platform: string;
  standalone: boolean;
  sea: boolean;
  execPath: string;
  node?: string;
}) {
  bootLog("agent boot", {
    platform: info.platform,
    standalone: info.standalone,
    sea: info.sea,
    exec: basename(info.execPath),
    node: info.node ?? process.version,
    pid: process.pid,
  });
}
