# Подготовка обновления Dauys перед заменой bin\dauys-agent.exe (без прав администратора).
# Вызывается Inno Setup (PrepareToInstall / ssInstall / BeforeInstall) и вручную.
# Журнал: %LOCALAPPDATA%\DauysAgent\upgrade-prepare.log (без секретов).
param(
  [string]$Root = ''
)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$aclLib = Join-Path $here 'DauysAcl.ps1'
if (-not (Test-Path -LiteralPath $aclLib)) {
  Write-Error "Не найден DauysAcl.ps1 рядом с Prepare-DauysUpgrade.ps1 ($aclLib)"
  exit 1
}
. $aclLib

try {
  Write-DauysUpgradeLog ("script_path={0}" -f $MyInvocation.MyCommand.Path)
  Write-DauysUpgradeLog ("acl_lib={0}" -f $aclLib)
  Write-DauysUpgradeLog ("ps_pid={0} session={1}" -f $PID, (Get-DauysCurrentSessionId))
  if ($Root) {
    Invoke-DauysUpgradePrepare -Root $Root
  } else {
    Invoke-DauysUpgradePrepare
  }
  Write-Output 'OK: Dauys готов к обновлению'
  exit 0
} catch {
  try { Write-DauysUpgradeLog ("phase=fail exception={0}" -f $_.Exception.Message) } catch { }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
