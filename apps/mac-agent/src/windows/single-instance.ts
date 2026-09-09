import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

function lockPath(dataDir: string) {
  return resolve(dataDir, "agent.lock");
}

function pidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class SingleInstanceError extends Error {
  constructor(public readonly otherPid: number) {
    super(
      "Dauys Agent уже запущен (PID " +
        otherPid +
        "). Закройте его из трея или завершите процесс.",
    );
    this.name = "SingleInstanceError";
  }
}

/** Acquire exclusive lock via agent.lock (PID). Throws SingleInstanceError if another live instance holds it. */
export async function acquireSingleInstance(dataDir: string) {
  await mkdir(dataDir, { recursive: true });
  const path = lockPath(dataDir);
  try {
    const raw = (await readFile(path, "utf8")).trim();
    const other = Number(raw);
    if (pidAlive(other) && other !== process.pid)
      throw new SingleInstanceError(other);
  } catch (e) {
    if (e instanceof SingleInstanceError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      /* stale/corrupt — overwrite */
    }
  }
  await writeFile(path, String(process.pid), { encoding: "utf8", flag: "w" });
  return async () => {
    try {
      const raw = (await readFile(path, "utf8")).trim();
      if (Number(raw) === process.pid) await unlink(path);
    } catch {
      /* ignore */
    }
  };
}
