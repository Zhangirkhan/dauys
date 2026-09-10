# Рядом — удаление Windows-агента (без прав администратора)
param([switch]$Purge)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$aclLib = Join-Path $here 'DauysAcl.ps1'
if (-not (Test-Path -LiteralPath $aclLib)) {
  throw "Не найден DauysAcl.ps1 рядом с uninstall.ps1 ($aclLib). Пересоберите: pnpm build:agent:windows"
}
. $aclLib

try {
  Stop-DauysAgentProcess
  Start-Sleep -Milliseconds 400
  Stop-DauysAgentProcess

  $root = Get-DauysAgentRoot
  if (Test-Path -LiteralPath $root) {
    # Восстановить доступ к bin/helpers и при purge — к данным текущего пользователя
    Repair-DauysAgentTreeAcl -Root $root
  }

  $startup = [Environment]::GetFolderPath('Startup')
  $shortcutPath = Join-Path $startup 'DauysAgent.lnk'
  if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
  }

  $bin = Join-Path $root 'bin'
  if (Test-Path -LiteralPath $bin) {
    Remove-Item -LiteralPath $bin -Recurse -Force
  }
  $helpers = Join-Path $root 'helpers'
  if (Test-Path -LiteralPath $helpers) {
    Remove-Item -LiteralPath $helpers -Recurse -Force
  }

  if ($Purge) {
    if (Test-Path -LiteralPath $root) {
      Remove-Item -LiteralPath $root -Recurse -Force
    }
    Write-Host 'Данные и токен удалены.'
  } else {
    Write-Host 'Бинарник и автозапуск удалены. Данные: %LOCALAPPDATA%\DauysAgent (добавьте -Purge чтобы стереть).'
  }
} catch {
  Write-Error ("Удаление DauysAgent не выполнено: {0}. Если helpers недоступны — запустите Prepare-DauysUpgrade.ps1 или install.ps1 (чинит ACL bin), затем повторите uninstall.ps1 -Purge." -f $_.Exception.Message)
  exit 1
}
