# Подготовка обновления Dauys перед заменой bin\dauys-agent.exe (без прав администратора).
# Вызывается Inno Setup (PrepareToInstall / BeforeInstall) и вручную.
# Журнал: -LogPath (из Inno: {tmp}\dauys-upgrade-prepare.log) и %LOCALAPPDATA%\DauysAgent\upgrade-prepare.log
param(
  [string]$Root = '',
  [string]$LogPath = ''
)
$ErrorActionPreference = 'Stop'

function Write-BootstrapLog {
  param([string]$Message)
  $line = '{0} ps1 {1}' -f ([DateTime]::UtcNow.ToString('o')), $Message
  [Console]::Out.WriteLine($line)
  $targets = @()
  if ($LogPath) { $targets += $LogPath }
  try {
    $local = Join-Path $env:LOCALAPPDATA 'DauysAgent\upgrade-prepare.log'
    $targets += $local
  } catch { }
  foreach ($t in $targets) {
    if (-not $t) { continue }
    try {
      $dir = Split-Path -Parent $t
      if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
      }
      Add-Content -LiteralPath $t -Value $line -Encoding UTF8
    } catch {
      [Console]::Error.WriteLine(("log_write_fail path={0} err={1}" -f $t, $_.Exception.Message))
    }
  }
}

# Первая строка ДО любой ACL-операции и до dot-source DauysAcl.ps1
Write-BootstrapLog 'marker=UPGRADE_PREPARE_V3 phase=ps1_enter'
Write-BootstrapLog ("script_path={0}" -f $MyInvocation.MyCommand.Path)
Write-BootstrapLog ("log_path_arg={0}" -f $LogPath)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$aclLib = Join-Path $here 'DauysAcl.ps1'
Write-BootstrapLog ("acl_lib={0} exists={1}" -f $aclLib, (Test-Path -LiteralPath $aclLib))
if (-not (Test-Path -LiteralPath $aclLib)) {
  Write-BootstrapLog 'phase=fail reason=missing_DauysAcl'
  Write-Error "Не найден DauysAcl.ps1 рядом с Prepare-DauysUpgrade.ps1 ($aclLib)"
  exit 1
}
. $aclLib

try {
  if ($LogPath) {
    # Перенаправить Write-DauysUpgradeLog также в Inno tmp-лог
    $script:DauysUpgradeLogOverride = $LogPath
  }
  Write-DauysUpgradeLog ("ps_pid={0} session={1}" -f $PID, (Get-DauysCurrentSessionId))
  if ($Root) {
    Invoke-DauysUpgradePrepare -Root $Root
  } else {
    Invoke-DauysUpgradePrepare
  }
  Write-BootstrapLog 'phase=ps1_ok'
  Write-Output 'OK: Dauys готов к обновлению'
  exit 0
} catch {
  try { Write-BootstrapLog ("phase=fail exception={0}" -f $_.Exception.Message) } catch { }
  try { Write-DauysUpgradeLog ("phase=fail exception={0}" -f $_.Exception.Message) } catch { }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
