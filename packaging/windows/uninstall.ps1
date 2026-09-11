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

  $root = Join-Path $env:LOCALAPPDATA 'DauysAgent'
  if (Test-Path -LiteralPath $root) {
    # Восстановить доступ к helpers/bin перед удалением (старые ACL)
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

  if ($Purge) {
    if (Test-Path -LiteralPath $root) {
      Remove-Item -LiteralPath $root -Recurse -Force
    }
    Write-Host 'Данные и токен удалены.'
  } else {
    Write-Host 'Бинарник и автозапуск удалены. Данные: %LOCALAPPDATA%\DauysAgent (добавьте -Purge чтобы стереть).'
  }
} catch {
  Write-Error ("Удаление DauysAgent не выполнено: {0}. Если helpers недоступны — запустите install.ps1 (он чинит ACL) или вручную icacls для текущего пользователя, затем повторите uninstall.ps1 -Purge." -f $_.Exception.Message)
  exit 1
}
