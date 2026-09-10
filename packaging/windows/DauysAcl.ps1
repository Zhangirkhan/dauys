# Shared ACL / process helpers for Dauys Windows install/uninstall (Windows PowerShell 5.1+)
# Only DACL via GetAccessControl(Access)/SetAccessControl or icacls — not SACL/owner cmdlets.

function Get-DauysCurrentUserSid {
  return [System.Security.Principal.WindowsIdentity]::GetCurrent().User
}

function Get-DauysAgentRoot {
  return [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'DauysAgent'))
}

function Assert-DauysInsideAgentRoot {
  param([Parameter(Mandatory = $true)][string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  $root = Get-DauysAgentRoot
  $sep = [System.IO.Path]::DirectorySeparatorChar
  $ok =
    $full.Equals($root, [System.StringComparison]::OrdinalIgnoreCase) -or
    $full.StartsWith($root + $sep, [System.StringComparison]::OrdinalIgnoreCase)
  if (-not $ok) {
    throw "Отказ: операция разрешена только внутри '$root' (получено '$full')"
  }
  return $full
}

function Get-DauysCurrentSessionId {
  try {
    return (Get-Process -Id $PID -ErrorAction Stop).SessionId
  } catch {
    return $null
  }
}

<#
  Завершает только процессы Dauys текущей пользовательской сессии:
  dauys-agent.exe, tray-host (powershell), dauys-launch.vbs (wscript/cscript).
  Не трогает процессы других сессий и не требует администратора.
#>
function Stop-DauysAgentProcess {
  $sessionId = Get-DauysCurrentSessionId
  $selfPid = $PID
  $root = Get-DauysAgentRoot
  $rootEsc = [regex]::Escape($root)

  $candidates = @()
  try {
    $candidates = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
      Where-Object {
        if ($null -ne $sessionId -and $_.SessionId -ne $sessionId) { return $false }
        if ($_.ProcessId -eq $selfPid) { return $false }
        $name = [string]$_.Name
        $cmd = [string]$_.CommandLine
        if ($name -ieq 'dauys-agent.exe') { return $true }
        if ($name -match '^(powershell|powershell_ise|pwsh)\.exe$' -and
            ($cmd -match 'tray-host\.ps1' -or $cmd -match $rootEsc)) { return $true }
        if ($name -match '^(wscript|cscript)\.exe$' -and
            ($cmd -match 'dauys-launch\.vbs' -or $cmd -match $rootEsc)) { return $true }
        return $false
      })
  } catch {
    # Fallback без CommandLine: только dauys-agent текущей сессии
    Get-Process -Name 'dauys-agent' -ErrorAction SilentlyContinue | ForEach-Object {
      if ($null -eq $sessionId -or $_.SessionId -eq $sessionId) {
        try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch { }
      }
    }
    Start-Sleep -Milliseconds 700
    return
  }

  foreach ($proc in $candidates) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
    } catch {
      try {
        $null = $_.Terminate()
      } catch { }
    }
  }

  # Дать ОС отпустить handle на exe
  Start-Sleep -Milliseconds 800

  $lock = Join-Path $root 'agent.lock'
  if (Test-Path -LiteralPath $lock) {
    try { Remove-Item -LiteralPath $lock -Force -ErrorAction Stop } catch { }
  }
}

function Test-DauysAgentRunning {
  $sessionId = Get-DauysCurrentSessionId
  $alive = @(Get-Process -Name 'dauys-agent' -ErrorAction SilentlyContinue |
    Where-Object { $null -eq $sessionId -or $_.SessionId -eq $sessionId })
  return ($alive.Count -gt 0)
}

function Set-DauysDaclAccessRule {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][System.Security.AccessControl.FileSystemAccessRule]$Rule
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Путь не найден: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force
  $sections = [System.Security.AccessControl.AccessControlSections]::Access
  if (-not $item.PSObject.Methods['GetAccessControl']) {
    throw "GetAccessControl недоступен. Используйте Windows PowerShell 5.1 или отремонтируйте ACL через icacls."
  }
  try {
    $acl = $item.GetAccessControl($sections)
    $acl.SetAccessRule($Rule)
    $item.SetAccessControl($acl)
  } catch {
    throw ("Не удалось изменить только DACL для '{0}' без прав администратора: {1}" -f $Path, $_.Exception.Message)
  }
}

function Grant-DauysCurrentUserFullControl {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$InheritToChildren
  )
  $sid = Get-DauysCurrentUserSid
  if ($InheritToChildren) {
    $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $inherit = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $sid,
    'FullControl',
    $inherit,
    [System.Security.AccessControl.PropagationFlags]::None,
    'Allow'
  )
  Set-DauysDaclAccessRule -Path $Path -Rule $rule
}

function Invoke-DauysIcacls {
  param(
    [Parameter(Mandatory = $true)][string[]]$ArgumentList
  )
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  if (-not (Test-Path -LiteralPath $icacls)) {
    throw "Не найден icacls.exe ($icacls)"
  }
  $out = & $icacls @ArgumentList 2>&1
  $code = $LASTEXITCODE
  if ($code -gt 1) {
    $text = ($out | Out-String).Trim()
    throw ("icacls завершился с кодом {0}: {1}" -f $code, $text)
  }
  return $out
}

<#
  Чинит DACL только для bin\ и helpers\ (миграция со старых ACL).
  Не трогает token / trust / ledger / agent-apps / agent-config.
#>
function Repair-DauysBinAcl {
  param(
    [Parameter(Mandatory = $false)][string]$Root
  )
  if (-not $Root) { $Root = Get-DauysAgentRoot }
  if (-not (Test-Path -LiteralPath $Root)) { return }

  $rootFull = Assert-DauysInsideAgentRoot -Path $Root
  $sid = Get-DauysCurrentUserSid
  $sidGrant = '*{0}:(OI)(CI)F' -f $sid.Value
  $sidFile = '*{0}:F' -f $sid.Value

  foreach ($name in @('bin', 'helpers')) {
    $child = Join-Path $rootFull $name
    if (-not (Test-Path -LiteralPath $child)) {
      New-Item -ItemType Directory -Force -Path $child | Out-Null
    }
    try {
      Invoke-DauysIcacls -ArgumentList @($child, '/inheritance:e', '/T', '/C', '/Q') | Out-Null
    } catch {
      Write-Warning ("inheritance:e для {0}: {1}" -f $child, $_.Exception.Message)
    }
    try {
      Grant-DauysCurrentUserFullControl -Path $child -InheritToChildren
    } catch {
      Write-Warning ("DACL {0} через .NET не применился: {1}" -f $child, $_.Exception.Message)
    }
    Invoke-DauysIcacls -ArgumentList @($child, '/grant:r', $sidGrant, '/T', '/C', '/Q') | Out-Null
  }

  $exe = Join-Path $rootFull 'bin\dauys-agent.exe'
  if (Test-Path -LiteralPath $exe) {
    try {
      Invoke-DauysIcacls -ArgumentList @($exe, '/inheritance:e', '/C', '/Q') | Out-Null
    } catch { }
    try {
      Grant-DauysCurrentUserFullControl -Path $exe
    } catch { }
    Invoke-DauysIcacls -ArgumentList @($exe, '/grant:r', $sidFile, '/C', '/Q') | Out-Null
  }
}

<#
  Для uninstall/purge: восстановить доступ текущего пользователя к дереву DauysAgent,
  чтобы можно было удалить bin/helpers и при необходимости данные.
  Не добавляет права другим пользователям / Everyone.
#>
function Repair-DauysAgentTreeAcl {
  param(
    [Parameter(Mandatory = $true)][string]$Root
  )
  if (-not (Test-Path -LiteralPath $Root)) { return }

  $rootFull = Assert-DauysInsideAgentRoot -Path $Root
  $sid = Get-DauysCurrentUserSid
  $sidGrant = '*{0}:(OI)(CI)F' -f $sid.Value
  $sidFile = '*{0}:F' -f $sid.Value

  Repair-DauysBinAcl -Root $rootFull

  # Данные: явный FullControl текущему SID без наследования на файлы секретов
  $privateNames = @(
    'agent-token.json',
    'agent-trust.json',
    'agent-apps.json',
    'agent-config.json',
    'executions.db',
    'executions.db-wal',
    'executions.db-shm',
    'agent.lock',
    'agent.log'
  )
  foreach ($name in $privateNames) {
    $path = Join-Path $rootFull $name
    if (-not (Test-Path -LiteralPath $path)) { continue }
    try {
      Grant-DauysCurrentUserFullControl -Path $path
    } catch {
      try {
        Invoke-DauysIcacls -ArgumentList @($path, '/grant:r', $sidFile, '/C', '/Q') | Out-Null
      } catch {
        Write-Warning ("Не удалось восстановить доступ к {0}: {1}" -f $name, $_.Exception.Message)
      }
    }
  }

  try {
    Grant-DauysCurrentUserFullControl -Path $rootFull -InheritToChildren
  } catch {
    Write-Warning ("DACL корня через .NET не применился, пробуем icacls: {0}" -f $_.Exception.Message)
    Invoke-DauysIcacls -ArgumentList @($rootFull, '/grant:r', $sidGrant, '/C') | Out-Null
  }
}

<#
  Подготовка обновления: остановить агент текущей сессии, починить ACL bin/helpers,
  проверить что dauys-agent.exe можно заменить. Не пропускает файл.
#>
function Invoke-DauysUpgradePrepare {
  param(
    [Parameter(Mandatory = $false)][string]$Root
  )
  if (-not $Root) { $Root = Get-DauysAgentRoot }
  $root = Assert-DauysInsideAgentRoot -Path $Root
  $bin = Join-Path $root 'bin'
  $exe = Join-Path $bin 'dauys-agent.exe'

  Stop-DauysAgentProcess
  Start-Sleep -Milliseconds 400
  Stop-DauysAgentProcess

  if (Test-DauysAgentRunning) {
    throw @"
Не удалось остановить Dauys перед обновлением.
Закройте агент через значок в трее (Выйти), подождите 5 секунд и снова запустите установщик.
Права администратора не нужны.
"@
  }

  if (Test-Path -LiteralPath $root) {
    Repair-DauysBinAcl -Root $root
  } else {
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    Repair-DauysBinAcl -Root $root
  }

  $lock = Join-Path $root 'agent.lock'
  if (Test-Path -LiteralPath $lock) {
    try { Remove-Item -LiteralPath $lock -Force -ErrorAction Stop } catch { }
  }

  if (Test-Path -LiteralPath $exe) {
    $probe = Join-Path $bin ('dauys-agent.exe.upgrade-' + [guid]::NewGuid().ToString('N'))
    try {
      Move-Item -LiteralPath $exe -Destination $probe -Force -ErrorAction Stop
      Move-Item -LiteralPath $probe -Destination $exe -Force -ErrorAction Stop
    } catch {
      try { if (Test-Path -LiteralPath $probe) { Move-Item -LiteralPath $probe -Destination $exe -Force } } catch { }
      throw @"
Не удалось получить доступ к файлу:
$exe

Код ошибки Windows обычно 5 (отказано в доступе).
1) Закройте Dauys из трея (Выйти).
2) Запустите установщик ещё раз (без прав администратора).
3) Если ошибка повторяется: Параметры → Приложения → Dauys → Удалить (сохранить настройки), затем установите заново.

Детали: $($_.Exception.Message)
"@
    }
  }
}
