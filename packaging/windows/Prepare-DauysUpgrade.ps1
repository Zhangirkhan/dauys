# Подготовка обновления Dauys перед заменой bin\dauys-agent.exe (без прав администратора).
# Вызывается Inno Setup (PrepareToInstall) и может запускаться вручную.
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
  if ($Root) {
    Invoke-DauysUpgradePrepare -Root $Root
  } else {
    Invoke-DauysUpgradePrepare
  }
  Write-Output 'OK: Dauys готов к обновлению'
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
