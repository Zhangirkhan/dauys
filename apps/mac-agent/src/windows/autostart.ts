import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, access, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const exec = promisify(execFile);

function appData() {
  return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
}

function startupDir() {
  return join(appData(), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

function startMenuDir() {
  return join(appData(), "Microsoft", "Windows", "Start Menu", "Programs", "Dauys");
}

export function launchVbsPath(exePath = process.execPath) {
  return join(dirname(exePath), "dauys-launch.vbs");
}

export async function ensureLaunchVbs(exePath = process.execPath) {
  const vbs = launchVbsPath(exePath);
  const body =
    'Set sh = CreateObject("WScript.Shell")\r\n' +
    'sh.Run """" & Replace("' +
    exePath.replace(/'/g, "''") +
    '", "/", "\\") & """", 0, False\r\n';
  await writeFile(vbs, body, "utf8");
  return vbs;
}

async function createShortcut(lnkPath: string, target: string, workDir: string) {
  const ps =
    "$s = New-Object -ComObject WScript.Shell; " +
    "$l = $s.CreateShortcut($env:DAUYS_LNK); " +
    "$l.TargetPath = $env:DAUYS_TARGET; " +
    "$l.WorkingDirectory = $env:DAUYS_WD; " +
    "$l.WindowStyle = 7; " +
    "$l.Save()";
  await exec(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
    {
      env: {
        ...process.env,
        DAUYS_LNK: lnkPath,
        DAUYS_TARGET: target,
        DAUYS_WD: workDir,
      },
      windowsHide: true,
      timeout: 15000,
    },
  );
}

export async function setAutostart(enabled: boolean, exePath = process.execPath) {
  const lnk = join(startupDir(), "DauysAgent.lnk");
  if (!enabled) {
    try {
      await unlink(lnk);
    } catch {
      /* ok */
    }
    return { enabled: false, path: lnk };
  }
  await mkdir(startupDir(), { recursive: true });
  const vbs = await ensureLaunchVbs(exePath);
  await createShortcut(lnk, vbs, dirname(exePath));
  return { enabled: true, path: lnk };
}

export async function ensureStartMenuShortcut(exePath = process.execPath) {
  const dir = startMenuDir();
  await mkdir(dir, { recursive: true });
  const lnk = join(dir, "Dauys.lnk");
  const vbs = await ensureLaunchVbs(exePath);
  await createShortcut(lnk, vbs, dirname(exePath));
  return lnk;
}

export async function isAutostartEnabled() {
  try {
    await access(join(startupDir(), "DauysAgent.lnk"));
    return true;
  } catch {
    return false;
  }
}
