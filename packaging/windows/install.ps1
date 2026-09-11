# Рядом — установка Windows-агента (пользовательская сессия, без службы / без admin)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$aclLib = Join-Path $here 'DauysAcl.ps1'
if (-not (Test-Path -LiteralPath $aclLib)) {
  throw "Не найден DauysAcl.ps1 рядом с install.ps1 ($aclLib). Пересоберите: pnpm build:agent:windows"
}
. $aclLib

$exe = Join-Path $here 'dauys-agent.exe'
if (-not (Test-Path -LiteralPath $exe)) {
  throw "Не найден dauys-agent.exe рядом со скриптом. Соберите на Windows 11 x64: pnpm build:agent:windows"
}

try {
  Stop-DauysAgentProcess

  $root = Join-Path $env:LOCALAPPDATA 'DauysAgent'
  $destDir = Join-Path $root 'bin'
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null

  # Сначала чиним ACL от прежних версий (helpers/bin), только внутри DauysAgent
  Repair-DauysAgentTreeAcl -Root $root

  Grant-DauysCurrentUserFullControl -Path $root -InheritToChildren
  Grant-DauysCurrentUserFullControl -Path $destDir -InheritToChildren

  $dest = Join-Path $destDir 'dauys-agent.exe'
  Copy-Item -LiteralPath $exe -Destination $dest -Force
  Grant-DauysCurrentUserFullControl -Path $dest

  if (-not (Test-Path -LiteralPath $dest)) {
    throw "После копирования файл недоступен: $dest"
  }

  $startup = [Environment]::GetFolderPath('Startup')
  $shortcutPath = Join-Path $startup 'DauysAgent.lnk'
  $wsh = New-Object -ComObject WScript.Shell
  $sc = $wsh.CreateShortcut($shortcutPath)
  $sc.TargetPath = $dest
  $sc.WorkingDirectory = $destDir
  $sc.Arguments = ''
  $sc.WindowStyle = 1
  $sc.Description = 'Рядом — голосовой агент'
  $sc.Save()

  Write-Host "Установлено: $dest"
  Write-Host "Автозапуск: $shortcutPath"
  Write-Host "Запуск сейчас..."
  Start-Process -FilePath $dest
  Write-Host "Отключение автозапуска: удалите ярлык или запустите uninstall.ps1"
} catch {
  Write-Error ("Установка DauysAgent не выполнена: {0}" -f $_.Exception.Message)
  exit 1
}
