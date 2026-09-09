import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
const UTF8_BOM = "\uFEFF";

/**
 * File: owner-only ACL, no inherit.
 * Directory: owner FullControl with (OI)(CI) so children (e.g. future files) stay reachable.
 * Never apply directory lockdown to a tree root that also holds bin\ — see index.ts.
 */
const PROTECT_PS1 = `# DauysAgent — только DACL текущего пользователя (SID); без cmdlet'ов SACL/owner
param(
  [Parameter(Mandatory = $true)][string]$Path
)
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$item = Get-Item -LiteralPath $Path -Force
$sections = [System.Security.AccessControl.AccessControlSections]::Access
$acl = $item.GetAccessControl($sections)
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
  [void]$acl.RemoveAccessRule($rule)
}
if ($item.PSIsContainer) {
  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagate = [System.Security.AccessControl.PropagationFlags]::None
} else {
  $inherit = [System.Security.AccessControl.InheritanceFlags]::None
  $propagate = [System.Security.AccessControl.PropagationFlags]::None
}
$access = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $identity.User,
  'FullControl',
  $inherit,
  $propagate,
  'Allow'
)
$acl.AddAccessRule($access)
$item.SetAccessControl($acl)
`;

export async function ensureWindowsHelpers(dataDir: string) {
  const dir = join(dataDir, "helpers");
  await mkdir(dir, { recursive: true });
  const files: Record<string, string> = {
    "protect-file.ps1": PROTECT_PS1,
    "open-target.ps1": `# param Target — Start-Process без shell-интерполяции
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$Arguments = ''
)
$ErrorActionPreference = 'Stop'
if ($Arguments) {
  Start-Process -FilePath $Target -ArgumentList $Arguments
} else {
  Start-Process -FilePath $Target
}
`,
    "close-app.ps1": `param([Parameter(Mandatory = $true)][string]$ProcessName)
$ErrorActionPreference = 'Stop'
# Мягкое закрытие через CloseMainWindow, без Kill
$procs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output 'not_running'; exit 0 }
foreach ($p in $procs) {
  if ($p.CloseMainWindow()) {
    Write-Output ('close_sent:' + $p.Id)
  } else {
    Write-Output ('needs_ui:' + $p.Id)
  }
}
`,
    "media-playpause.ps1": `$wshell = New-Object -ComObject wscript.shell
$wshell.SendKeys([char]179)
`,
    "set-volume.ps1": `param([Parameter(Mandatory = $true)][int]$Volume)
$ErrorActionPreference = 'Stop'
if ($Volume -lt 0 -or $Volume -gt 100) { throw 'volume 0..100' }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DauysAudio {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public const byte VK_VOLUME_MUTE = 0xAD;
  public const byte VK_VOLUME_DOWN = 0xAE;
  public const byte VK_VOLUME_UP = 0xAF;
  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public static void Tap(byte vk) {
    keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY, UIntPtr.Zero);
    keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, UIntPtr.Zero);
  }
}
"@
# Грубая установка: mute cycle + up N раз от нуля (без внешних утилит)
for ($i = 0; $i -lt 50; $i++) { [DauysAudio]::Tap([DauysAudio]::VK_VOLUME_DOWN) }
$steps = [int][math]::Round($Volume / 2.0)
for ($i = 0; $i -lt $steps; $i++) { [DauysAudio]::Tap([DauysAudio]::VK_VOLUME_UP) }
`,
    "screenshot.ps1": `param([Parameter(Mandatory = $true)][string]$OutPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`,
    "foreground.ps1": `Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DauysFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$hwnd = [DauysFg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][DauysFg]::GetWindowText($hwnd, $sb, $sb.Capacity)
# $PID — автоматическая переменная PowerShell; для PID окна нужна своя
[uint32]$fgPid = 0
[void][DauysFg]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)
$name = ''
try { $name = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName } catch {}
Write-Output ($name + '|' + $sb.ToString())
`,
    "message-box.ps1": `param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Prompt
)
Add-Type -AssemblyName System.Windows.Forms
[void][System.Windows.Forms.MessageBox]::Show($Prompt, $Title)
`,
    "battery.ps1": `$ErrorActionPreference = 'Stop'
$b = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue
if (-not $b) { Write-Output 'no_battery'; exit 0 }
$pct = $b.EstimatedChargeRemaining
$status = switch ($b.BatteryStatus) {
  1 { 'разряжается' }
  2 { 'от сети / заряжается' }
  default { 'статус ' + $b.BatteryStatus }
}
Write-Output ("Заряд: $pct% · $status")
`,
    "input-box.ps1": `param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Prompt,
  [switch]$Password
)
Add-Type -AssemblyName Microsoft.VisualBasic
$default = ''
$result = [Microsoft.VisualBasic.Interaction]::InputBox($Prompt, $Title, $default)
if ([string]::IsNullOrEmpty($result)) { exit 1 }
Write-Output $result
`,
  };
  for (const [name, body] of Object.entries(files)) {
    const target = join(dir, name);
    const payload = UTF8_BOM + body;
    const hash = createHash("sha256").update(payload).digest("hex");
    let skip = false;
    try {
      const existing = await readFile(target);
      if (createHash("sha256").update(existing).digest("hex") === hash)
        skip = true;
    } catch {
      /* write */
    }
    if (!skip) await writeFile(target, payload, { encoding: "utf8" });
  }
  return dir;
}

export type RunPs1Options = {
  /** Default: 15000 non-interactive, 300000 interactive */
  timeout?: number;
  /** UI dialogs: no -NonInteractive, windowsHide=false */
  interactive?: boolean;
};

export async function runFixedPs1(
  scriptPath: string,
  args: string[],
  options: number | RunPs1Options = {},
) {
  const opts: RunPs1Options =
    typeof options === "number" ? { timeout: options } : options;
  const interactive = opts.interactive === true;
  const timeout =
    opts.timeout ?? (interactive ? 300_000 : 15_000);
  const psArgs = [
    "-NoProfile",
    ...(interactive ? [] : ["-NonInteractive"]),
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...args,
  ];
  try {
    const { stdout } = await exec("powershell.exe", psArgs, {
      timeout,
      windowsHide: !interactive,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean };
    if (err.killed || err.message?.includes("TIMEDOUT")) {
      throw new Error(
        "Таймаут PowerShell helper (" +
          timeout +
          "ms): " +
          scriptPath.split(/[/\\]/).pop(),
      );
    }
    throw e;
  }
}

/** Restrict ACL to the current user only (SID from WindowsIdentity; no hardcoded name). */
export async function protectUserFile(filePath: string, helpersDir: string) {
  const script = join(helpersDir, "protect-file.ps1");
  await runFixedPs1(script, ["-Path", filePath], { timeout: 15_000 });
}

/**
 * Private data directory only — not the install root that contains bin\\.
 * Applies inheritable FullControl for the current user.
 */
export async function ensurePrivateDir(dir: string, helpersDir: string) {
  await mkdir(dir, { recursive: true });
  try {
    const info = await stat(dir);
    if (!info.isDirectory())
      throw new Error("ensurePrivateDir ожидает каталог: " + dir);
    await protectUserFile(dir, helpersDir);
  } catch {
    /* directory ACL may fail on some FS; files still protected */
  }
}

export function helperPath(helpersDir: string, name: string) {
  if (!/^[a-z0-9._-]+\.ps1$/i.test(name))
    throw new Error("Недопустимый helper");
  return join(helpersDir, name);
}
