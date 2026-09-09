# Shared ACL helpers for Dauys Windows install/uninstall (Windows PowerShell 5.1+)
# Only DACL via GetAccessControl(Access)/SetAccessControl or icacls — not SACL/owner cmdlets.

function Get-DauysCurrentUserSid {
  return [System.Security.Principal.WindowsIdentity]::GetCurrent().User
}

function Stop-DauysAgentProcess {
  Get-Process -Name 'dauys-agent' -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch { }
  }
  Start-Sleep -Milliseconds 500
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
  Восстановление DACL внутри %LOCALAPPDATA%\DauysAgent для текущего пользователя.
  Не меняет владельца и SACL. Не выходит за пределы $Root.
#>
function Repair-DauysAgentTreeAcl {
  param(
    [Parameter(Mandatory = $true)][string]$Root
  )
  if (-not (Test-Path -LiteralPath $Root)) { return }

  $rootFull = [System.IO.Path]::GetFullPath($Root)
  $expected = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'DauysAgent'))
  if (-not $rootFull.StartsWith($expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Отказ: Repair разрешён только внутри '$expected' (получено '$rootFull')"
  }

  $sid = Get-DauysCurrentUserSid
  $sidGrant = '*{0}:(OI)(CI)F' -f $sid.Value

  try {
    Grant-DauysCurrentUserFullControl -Path $rootFull -InheritToChildren
  } catch {
    Write-Warning ("DACL корня через .NET не применился, пробуем icacls: {0}" -f $_.Exception.Message)
    Invoke-DauysIcacls -ArgumentList @($rootFull, '/grant:r', $sidGrant, '/C') | Out-Null
  }

  # Рекурсивно выдать текущему SID FullControl (только DACL)
  Invoke-DauysIcacls -ArgumentList @($rootFull, '/grant:r', $sidGrant, '/T', '/C', '/Q') | Out-Null

  foreach ($name in @('bin', 'helpers')) {
    $child = Join-Path $rootFull $name
    if (-not (Test-Path -LiteralPath $child)) { continue }
    # Включить наследование от корня, затем явный grant (чинит «пустые» ACL от старой версии)
    try {
      Invoke-DauysIcacls -ArgumentList @($child, '/inheritance:e', '/T', '/C', '/Q') | Out-Null
    } catch {
      Write-Warning ("inheritance:e для {0}: {1}" -f $child, $_.Exception.Message)
    }
    Invoke-DauysIcacls -ArgumentList @($child, '/grant:r', $sidGrant, '/T', '/C', '/Q') | Out-Null
  }
}
