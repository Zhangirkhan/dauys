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
  # Остановка агента/tray + ACL только bin/helpers; проверка, что exe можно заменить
  Invoke-DauysUpgradePrepare

  $root = Get-DauysAgentRoot
  $destDir = Join-Path $root 'bin'
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  Repair-DauysBinAcl -Root $root

  $dest = Join-Path $destDir 'dauys-agent.exe'
  Copy-Item -LiteralPath $exe -Destination $dest -Force
  Grant-DauysCurrentUserFullControl -Path $dest

  if (-not (Test-Path -LiteralPath $dest)) {
    throw "После копирования файл недоступен: $dest"
  }

  $helpersDir = Join-Path $root 'helpers'
  New-Item -ItemType Directory -Force -Path $helpersDir | Out-Null
  foreach ($name in @('DauysAcl.ps1', 'Prepare-DauysUpgrade.ps1')) {
    $src = Join-Path $here $name
    if (Test-Path -LiteralPath $src) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $helpersDir $name) -Force
    }
  }

  $vbs = Join-Path $destDir 'dauys-launch.vbs'
  $vbsBody = "Set sh = CreateObject(`"WScript.Shell`")`r`nsh.Run `"`"`"$dest`"`"`", 0, False`r`n"
  Set-Content -LiteralPath $vbs -Value $vbsBody -Encoding ASCII

  $startup = [Environment]::GetFolderPath('Startup')
  $shortcutPath = Join-Path $startup 'DauysAgent.lnk'
  $wsh = New-Object -ComObject WScript.Shell
  $sc = $wsh.CreateShortcut($shortcutPath)
  $sc.TargetPath = $vbs
  $sc.WorkingDirectory = $destDir
  $sc.Arguments = ''
  $sc.WindowStyle = 7
  $sc.Description = 'Dauys — голосовой агент'
  $sc.Save()

  Write-Host "Установлено: $dest"
  Write-Host "Автозапуск: $shortcutPath (через VBS, без консоли)"
  Write-Host "Запуск сейчас..."
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WindowStyle Hidden
  Write-Host "Отключение автозапуска: удалите ярлык или запустите uninstall.ps1"
} catch {
  Write-Error ("Установка DauysAgent не выполнена: {0}" -f $_.Exception.Message)
  exit 1
}
