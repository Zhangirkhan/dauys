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
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [switch]$AllowPartial
  )
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  if (-not (Test-Path -LiteralPath $icacls)) {
    throw "Не найден icacls.exe ($icacls)"
  }
  $out = & $icacls @ArgumentList 2>&1
  $code = $LASTEXITCODE
  # icacls: 0=ok, 1=частичный сбой (/C), >1=полная ошибка.
  # Для exe замены частичный сбой = провал (иначе Inno DeleteFile код 5).
  $limit = if ($AllowPartial) { 1 } else { 0 }
  if ($code -gt $limit) {
    $text = ($out | Out-String).Trim()
    throw ("icacls завершился с кодом {0}: {1}" -f $code, $text)
  }
  return $out
}

function Get-DauysUpgradeLogPath {
  return (Join-Path (Get-DauysAgentRoot) 'upgrade-prepare.log')
}

<#
  Журнал подготовки обновления без секретов (нет token/trust/ledger).
#>
function Write-DauysUpgradeLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  $line = '{0} {1}' -f ([DateTime]::UtcNow.ToString('o')), $Message
  try {
    $root = Get-DauysAgentRoot
    if (-not (Test-Path -LiteralPath $root)) {
      New-Item -ItemType Directory -Force -Path $root | Out-Null
    }
    Add-Content -LiteralPath (Get-DauysUpgradeLogPath) -Value $line -Encoding UTF8
  } catch {
    # Журнал не должен ломать подготовку
  }
  Write-Output $line
}

function Get-DauysSessionProcessSnapshot {
  $sessionId = Get-DauysCurrentSessionId
  $selfPid = $PID
  $root = Get-DauysAgentRoot
  $rootEsc = [regex]::Escape($root)
  $rows = @()
  try {
    $rows = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
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
      } |
      ForEach-Object { '{0}:{1}' -f $_.Name, $_.ProcessId })
  } catch {
    $rows = @(Get-Process -Name 'dauys-agent' -ErrorAction SilentlyContinue |
      Where-Object { $null -eq $sessionId -or $_.SessionId -eq $sessionId } |
      ForEach-Object { 'dauys-agent.exe:{0}' -f $_.Id })
  }
  return $rows
}

<#
  Чинит DACL только для bin\ и helpers\ (миграция со старых ACL).
  Не трогает token / trust / ledger / agent-apps / agent-config.
  Ошибки на exe не глотаются — иначе Inno DeleteFile даёт код 5.
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
  $sidStar = '*{0}' -f $sid.Value

  foreach ($name in @('bin', 'helpers')) {
    $child = Join-Path $rootFull $name
    if (-not (Test-Path -LiteralPath $child)) {
      New-Item -ItemType Directory -Force -Path $child | Out-Null
    }
    try {
      Invoke-DauysIcacls -ArgumentList @($child, '/inheritance:e', '/T', '/C', '/Q') -AllowPartial | Out-Null
      Write-DauysUpgradeLog ("acl_dir inheritance_e path={0} ok" -f $name)
    } catch {
      Write-DauysUpgradeLog ("acl_dir inheritance_e path={0} fail={1}" -f $name, $_.Exception.Message)
      Write-Warning ("inheritance:e для {0}: {1}" -f $child, $_.Exception.Message)
    }
    try {
      Grant-DauysCurrentUserFullControl -Path $child -InheritToChildren
      Write-DauysUpgradeLog ("acl_dir net_grant path={0} ok" -f $name)
    } catch {
      Write-DauysUpgradeLog ("acl_dir net_grant path={0} fail={1}" -f $name, $_.Exception.Message)
      Write-Warning ("DACL {0} через .NET не применился: {1}" -f $child, $_.Exception.Message)
    }
    # Для каталогов допускаем частичный обход старых объектов; exe чиним отдельно строго.
    Invoke-DauysIcacls -ArgumentList @($child, '/grant:r', $sidGrant, '/T', '/C', '/Q') -AllowPartial | Out-Null
    Write-DauysUpgradeLog ("acl_dir icacls_grant path={0} ok" -f $name)
  }

  $exe = Join-Path $rootFull 'bin\dauys-agent.exe'
  if (Test-Path -LiteralPath $exe) {
    # Старые установки: protected DACL / deny / только R+X — чиним явно и без /C-тишины.
    Invoke-DauysIcacls -ArgumentList @($exe, '/inheritance:e', '/Q') | Out-Null
    try {
      Grant-DauysCurrentUserFullControl -Path $exe
      Write-DauysUpgradeLog 'acl_exe net_grant ok'
    } catch {
      Write-DauysUpgradeLog ("acl_exe net_grant fail={0}" -f $_.Exception.Message)
    }
    try {
      Invoke-DauysIcacls -ArgumentList @($exe, '/remove:d', $sidStar, '/Q') | Out-Null
      Write-DauysUpgradeLog 'acl_exe remove_deny ok'
    } catch {
      Write-DauysUpgradeLog ("acl_exe remove_deny skip={0}" -f $_.Exception.Message)
    }
    Invoke-DauysIcacls -ArgumentList @($exe, '/grant:r', $sidFile, '/Q') | Out-Null
    Write-DauysUpgradeLog 'acl_exe icacls_grant ok'
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
        Invoke-DauysIcacls -ArgumentList @($path, '/grant:r', $sidFile, '/C', '/Q') -AllowPartial | Out-Null
      } catch {
        Write-Warning ("Не удалось восстановить доступ к {0}: {1}" -f $name, $_.Exception.Message)
      }
    }
  }

  try {
    Grant-DauysCurrentUserFullControl -Path $rootFull -InheritToChildren
  } catch {
    Write-Warning ("DACL корня через .NET не применился, пробуем icacls: {0}" -f $_.Exception.Message)
    Invoke-DauysIcacls -ArgumentList @($rootFull, '/grant:r', $sidGrant, '/C') -AllowPartial | Out-Null
  }
}

<#
  Подготовка обновления: остановить агент текущей сессии, починить ACL bin/helpers,
  УДАЛИТЬ старый exe (реальный DeleteFile), чтобы Inno не вызывал DeleteFile сам.

  Важно: rename (Move-Item) — ЛОЖНЫЙ probe. Windows часто позволяет переименовать
  mapped/занятый .exe, но DeleteFile даёт код 5. Именно это ломало обновление
  после f587ce0: PrepareUpgrade «успевал», Inno падал на DeleteFile.
#>
function Invoke-DauysUpgradePrepare {
  param(
    [Parameter(Mandatory = $false)][string]$Root
  )
  if (-not $Root) { $Root = Get-DauysAgentRoot }
  $root = Assert-DauysInsideAgentRoot -Path $Root
  $bin = Join-Path $root 'bin'
  $exe = Join-Path $bin 'dauys-agent.exe'
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User

  Write-DauysUpgradeLog 'marker=UPGRADE_PREPARE_V2 phase=start'
  Write-DauysUpgradeLog ("user={0} sid={1} elevated=false root={2}" -f $identity.Name, $sid.Value, $root)
  Write-DauysUpgradeLog ("exe={0} exists={1}" -f $exe, (Test-Path -LiteralPath $exe))

  $before = @(Get-DauysSessionProcessSnapshot)
  Write-DauysUpgradeLog ("processes_before count={0} list={1}" -f $before.Count, ($before -join ','))

  Stop-DauysAgentProcess
  Start-Sleep -Milliseconds 500
  Stop-DauysAgentProcess
  Start-Sleep -Milliseconds 700

  $afterStop = @(Get-DauysSessionProcessSnapshot)
  Write-DauysUpgradeLog ("processes_after_stop count={0} list={1}" -f $afterStop.Count, ($afterStop -join ','))

  if (Test-DauysAgentRunning) {
    Write-DauysUpgradeLog 'phase=fail reason=agent_still_running'
    throw @"
Не удалось остановить Dauys перед обновлением.
Закройте агент через значок в трее (Выйти), подождите 5 секунд и снова запустите установщик.
Права администратора не нужны.
Журнал: $(Get-DauysUpgradeLogPath)
"@
  }

  if (-not (Test-Path -LiteralPath $root)) {
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
  }
  Write-DauysUpgradeLog 'phase=acl_repair'
  Repair-DauysBinAcl -Root $root

  $lock = Join-Path $root 'agent.lock'
  if (Test-Path -LiteralPath $lock) {
    try {
      Remove-Item -LiteralPath $lock -Force -ErrorAction Stop
      Write-DauysUpgradeLog 'lock_removed=ok'
    } catch {
      Write-DauysUpgradeLog ("lock_removed=fail err={0}" -f $_.Exception.Message)
    }
  }

  if (-not (Test-Path -LiteralPath $exe)) {
    Write-DauysUpgradeLog 'phase=done exe_absent=true (Inno создаст новый файл)'
    return
  }

  # Readonly блокирует DeleteFile (код 5), но часто не мешает Rename.
  try {
    $item = Get-Item -LiteralPath $exe -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReadOnly) {
      $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
      Write-DauysUpgradeLog 'readonly_cleared=true'
    } else {
      Write-DauysUpgradeLog 'readonly_cleared=false (not_set)'
    }
  } catch {
    Write-DauysUpgradeLog ("readonly_cleared=fail err={0}" -f $_.Exception.Message)
  }

  # Реальный DeleteFile: убрать старый exe до [Files], иначе Inno сам зовёт DeleteFile.
  try {
    Remove-Item -LiteralPath $exe -Force -ErrorAction Stop
    Write-DauysUpgradeLog 'delete_exe=ok method=Remove-Item'
  } catch {
    $delErr = $_.Exception.Message
    Write-DauysUpgradeLog ("delete_exe=fail method=Remove-Item err={0}" -f $delErr)

    $probe = Join-Path $bin ('dauys-agent.exe.old-' + [guid]::NewGuid().ToString('N'))
    try {
      Move-Item -LiteralPath $exe -Destination $probe -Force -ErrorAction Stop
      Write-DauysUpgradeLog ("rename_exe=ok dest={0}" -f (Split-Path -Leaf $probe))
    } catch {
      Write-DauysUpgradeLog ("rename_exe=fail err={0}" -f $_.Exception.Message)
      Write-DauysUpgradeLog 'phase=fail reason=acl_or_lock (rename+delete both failed)'
      throw @"
Не удалось получить доступ к файлу:
$exe

DeleteFile/Remove-Item отказали (часто код 5), rename тоже не удался — ACL или блокировка.
1) Закройте Dauys из трея (Выйти).
2) Запустите установщик ещё раз (без прав администратора).
3) Если ошибка повторяется: Параметры → Приложения → Dauys → Удалить (сохранить настройки), затем установите заново.

Журнал: $(Get-DauysUpgradeLogPath)
Детали delete: $delErr
Детали rename: $($_.Exception.Message)
"@
    }

    try {
      Remove-Item -LiteralPath $probe -Force -ErrorAction Stop
      Write-DauysUpgradeLog 'delete_renamed=ok'
    } catch {
      Write-DauysUpgradeLog ("delete_renamed=fail err={0}" -f $_.Exception.Message)
      Write-DauysUpgradeLog 'phase=fail reason=in_use_after_rename (Windows: rename OK, DeleteFile FAIL)'
      throw @"
Файл занят (типичный ложный rename-probe):
$exe

Windows позволяет переименовать занятый .exe, но DeleteFile даёт «отказано в доступе» (код 5).
Inno Setup как раз вызывает DeleteFile — поэтому обновление падало после «успешной» подготовки.

Закройте Dauys из трея, подождите несколько секунд, повторите установку без прав администратора.
Журнал: $(Get-DauysUpgradeLogPath)
Старое имя: $probe
Детали: $($_.Exception.Message)
"@
    }
  }

  if (Test-Path -LiteralPath $exe) {
    Write-DauysUpgradeLog 'phase=fail reason=exe_still_present_after_delete'
    throw "После подготовки файл всё ещё существует: $exe"
  }

  Write-DauysUpgradeLog 'phase=done exe_removed=true (Inno установит без DeleteFile старого)'
}
