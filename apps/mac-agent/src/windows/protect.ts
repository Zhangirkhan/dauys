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
    "folder-picker.ps1": `param([string]$Description = 'Выберите папку')
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $Description
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }
Write-Output $dialog.SelectedPath
`,
    "known-folder.ps1": `param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('downloads','documents','desktop','pictures','music','videos')]
  [string]$Id
)
$ErrorActionPreference = 'Stop'
$path = switch ($Id) {
  'documents' { [Environment]::GetFolderPath('MyDocuments') }
  'desktop' { [Environment]::GetFolderPath('Desktop') }
  'pictures' { [Environment]::GetFolderPath('MyPictures') }
  'music' { [Environment]::GetFolderPath('MyMusic') }
  'videos' { [Environment]::GetFolderPath('MyVideos') }
  'downloads' {
    $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'
    $value = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).'{374DE290-123F-4565-9164-39C4925E467B}'
    if ($value) { [Environment]::ExpandEnvironmentVariables([string]$value) }
    else { Join-Path $env:USERPROFILE 'Downloads' }
  }
}
if ([string]::IsNullOrWhiteSpace($path)) { throw 'Системная папка не найдена' }
Write-Output ([System.IO.Path]::GetFullPath($path))
`,
    "discover-apps.ps1": `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$shell = New-Object -ComObject WScript.Shell
$results = New-Object System.Collections.Generic.List[object]
function Add-Lnk([string]$lnkPath) {
  try {
    $sc = $shell.CreateShortcut($lnkPath)
    $target = [string]$sc.TargetPath
    $args = [string]$sc.Arguments
    if ([string]::IsNullOrWhiteSpace($target)) { return }
    if ($target -match '^(https?:|file:|ms-msdt:|search-ms:|javascript:)' ) { return }
    if ($target.StartsWith('\\\\') -or $target.StartsWith('//')) { return }
    if ($target -notmatch '\\.exe$') { return }
    if ($args -match '(?i)(-Command|-EncodedCommand|powershell|pwsh|cmd\\.exe|/c\\b)') { return }
    $name = [System.IO.Path]::GetFileNameWithoutExtension($lnkPath)
    if ([string]::IsNullOrWhiteSpace($name) -or $name.Length -gt 80) { return }
    $results.Add([pscustomobject]@{ name = $name; path = $target; args = $args })
  } catch {}
}
function Add-Exe([string]$name, [string]$target) {
  try {
    if ([string]::IsNullOrWhiteSpace($name) -or $name.Length -gt 80) { return }
    $target = $target.Trim().Trim('"')
    if ($target -match '^"([^"]+\\.exe)"(?:,-?\\d+)?$') { $target = $Matches[1] }
    elseif ($target -match '^(.+\\.exe)(?:,-?\\d+)?$') { $target = $Matches[1] }
    if ($target.StartsWith('\\\\') -or $target.StartsWith('//')) { return }
    if ($target -notmatch '\\.exe$') { return }
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { return }
    $results.Add([pscustomobject]@{ name = $name; path = $target; args = '' })
  } catch {}
}
$dirs = @(
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs')
) | Select-Object -Unique
foreach ($dir in $dirs) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object { Add-Lnk $_.FullName }
}
# App Paths (HKCU + HKLM)
foreach ($root in @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths'
)) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $p = $_.GetValue('')
      $name = [System.IO.Path]::GetFileNameWithoutExtension($_.PSChildName)
      if ($p) { Add-Exe $name ([string]$p) }
    } catch {}
  }
}
# Installed-program records. Only an existing local .exe from DisplayIcon is used;
# uninstall commands and arguments are never imported.
foreach ($root in @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $p = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction Stop
      if ($p.DisplayName -and $p.DisplayIcon) {
        Add-Exe ([string]$p.DisplayName) ([string]$p.DisplayIcon)
      }
    } catch {}
  }
}
$results | ConvertTo-Json -Compress -Depth 3
`,
    "tray-host.ps1": `param([string]$IconPath = '')
$ErrorActionPreference = 'Stop'
$BaseUrl = [string]$env:DAUYS_CONTROL_BASE_URL
$Token = [string]$env:DAUYS_LOCAL_TOKEN
$env:DAUYS_CONTROL_BASE_URL = ''
$env:DAUYS_LOCAL_TOKEN = ''
if ([string]::IsNullOrWhiteSpace($BaseUrl) -or [string]::IsNullOrWhiteSpace($Token)) {
  throw 'Не заданы параметры локального control-server'
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:status = 'connecting'
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = 'Dauys'
$notify.Visible = $true
function Set-StatusIcon([string]$s) {
  $script:status = $s
  $color = switch ($s) {
    'connected' { [System.Drawing.Color]::LimeGreen }
    'connecting' { [System.Drawing.Color]::Gold }
    'error' { [System.Drawing.Color]::Red }
    default { [System.Drawing.Color]::Gray }
  }
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush $color
  $g.FillEllipse($brush, 1, 1, 14, 14)
  $g.Dispose(); $brush.Dispose()
  if ($notify.Icon) { $notify.Icon.Dispose() }
  $notify.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $notify.Text = 'Dauys: ' + $s
}
Set-StatusIcon 'connecting'

function Invoke-Agent([string]$Method, [string]$Path, [string]$Body = $null) {
  $url = $BaseUrl.TrimEnd('/') + $Path
  $req = [System.Net.HttpWebRequest]::Create($url)
  $req.Method = $Method
  $req.Headers.Add('X-Dauys-Local', $Token)
  $req.Timeout = 8000
  if ($Body -ne $null) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $req.ContentType = 'application/json; charset=utf-8'
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
  }
  $resp = $req.GetResponse()
  $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
  $text = $reader.ReadToEnd()
  $reader.Close(); $resp.Close()
  return $text
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miStatus = $menu.Items.Add('Состояние')
$miSettings = $menu.Items.Add('Открыть настройки')
$miPair = $menu.Items.Add('Новый код привязки')
$miReconnect = $menu.Items.Add('Переподключиться')
$miAutostart = $menu.Items.Add('Автозапуск')
$miLog = $menu.Items.Add('Открыть журнал')
$menu.Items.Add('-') | Out-Null
$miExit = $menu.Items.Add('Выйти')
$notify.ContextMenuStrip = $menu

$miStatus.add_Click({
  try {
    $j = Invoke-Agent 'GET' '/api/status' | ConvertFrom-Json
    $s = $j.data
    [System.Windows.Forms.MessageBox]::Show(
      ("Статус: {0}\`nСервер: {1}\`nПривязка: {2}\`nВерсия: {3}" -f $s.connection, $s.server, $s.paired, $s.version),
      'Dauys'
    ) | Out-Null
  } catch {
    [System.Windows.Forms.MessageBox]::Show('Не удалось получить статус', 'Dauys') | Out-Null
  }
})
$miSettings.add_Click({ try { Invoke-Agent 'POST' '/api/open-settings' | Out-Null } catch {} })
$miPair.add_Click({ try { Invoke-Agent 'POST' '/api/pair-again' | Out-Null } catch {} })
$miReconnect.add_Click({ try { Invoke-Agent 'POST' '/api/reconnect' | Out-Null } catch {} })
$miAutostart.add_Click({
  try {
    $j = Invoke-Agent 'POST' '/api/toggle-autostart' | ConvertFrom-Json
    [System.Windows.Forms.MessageBox]::Show(
      $(if ($j.data.autostart) { 'Автозапуск включён' } else { 'Автозапуск выключен' }),
      'Dauys'
    ) | Out-Null
  } catch {}
})
$miLog.add_Click({ try { Invoke-Agent 'POST' '/api/open-log' | Out-Null } catch {} })
$miExit.add_Click({
  try { Invoke-Agent 'POST' '/api/quit' | Out-Null } catch {}
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$script:failures = 0
$timer.add_Tick({
  try {
    $j = Invoke-Agent 'GET' '/api/status' | ConvertFrom-Json
    $script:failures = 0
    Set-StatusIcon ([string]$j.data.connection)
  } catch {
    $script:failures++
    Set-StatusIcon 'error'
    if ($script:failures -ge 5) {
      $notify.Visible = $false
      [System.Windows.Forms.Application]::Exit()
    }
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
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
