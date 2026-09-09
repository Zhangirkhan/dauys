import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export type TrayHandle = {
  child: ChildProcess;
  stop: () => void;
};

/** Spawn hidden tray-host.ps1 bound to the local control server. */
export function startTray(o: {
  helpersDir: string;
  baseUrl: string;
  token: string;
  iconPath?: string;
}): TrayHandle {
  const script = join(o.helpersDir, "tray-host.ps1");
  const args = [
    "-NoProfile",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-BaseUrl",
    o.baseUrl,
    "-Token",
    o.token,
  ];
  if (o.iconPath) args.push("-IconPath", o.iconPath);
  const child = spawn("powershell.exe", args, {
    windowsHide: true,
    stdio: "ignore",
    detached: false,
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  };
  child.on("exit", () => {
    stopped = true;
  });
  return { child, stop };
}
