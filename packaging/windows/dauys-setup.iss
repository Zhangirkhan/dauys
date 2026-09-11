; Dauys Windows agent — per-user installer (no admin)
; Built by: pnpm build:agent:windows-installer
;
; Upgrade scripts: ONLY via DestDir "dauys-upgrade" + Flags dontcopy + ExtractTemporaryFiles.
; Duplicate basename with {app}\helpers is OK — ExtractTemporaryFiles('dauys-upgrade\*') is unambiguous.

#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#ifndef SourceAgentDir
  #define SourceAgentDir "..\..\dist\windows"
#endif

#define MyAppName "Dauys"
#define MyAppPublisher "ESL"
#define MyAppExeName "dauys-agent.exe"
#define MyAppId "{{A7C3E9F1-4B2D-4E8A-9C1F-D0A5B6E7F801}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\DauysAgent
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist\windows-installer
OutputBaseFilename=DauysSetup-x64
#ifdef DauysVerifyPlain
Compression=none
SolidCompression=no
#else
Compression=lzma2
SolidCompression=yes
#endif
WizardStyle=modern
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\bin\{#MyAppExeName}
CloseApplications=force
CloseApplicationsFilter=*.exe,*.dll,*.chm,*.vbs
RestartApplications=no
SetupLogging=yes
VersionInfoVersion={#MyAppVersion}.0
VersionInfoProductVersion={#MyAppVersion}
; No Authenticode here — packaging/windows/SIGNING.md

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Запускать Dauys при входе в Windows"; Flags: checkedonce
Name: "desktopicon"; Description: "Ярлык на рабочем столе"; Flags: unchecked

[Files]
; --- MUST be first (solid compression): ExtractTemporaryFiles before [Files] copy ---
; DestDir without {tmp}/{app}: extracts to {tmp}\dauys-upgrade\ (see Inno ExtractTemporaryFiles docs)
Source: "DauysAcl.ps1"; DestDir: "dauys-upgrade"; Flags: dontcopy noencryption solidbreak
Source: "Prepare-DauysUpgrade.ps1"; DestDir: "dauys-upgrade"; Flags: dontcopy noencryption solidbreak
; Agent binary — BeforeInstall must succeed before Setup touches this dest (no DeleteFile if prepare aborts)
Source: "{#SourceAgentDir}\dauys-agent.exe"; DestDir: "{app}\bin"; Flags: ignoreversion overwritereadonly; BeforeInstall: PrepareUpgradeOrFail
; Installed copies for manual re-run / uninstall helpers (separate DestDir — not used by ExtractTemporaryFiles)
Source: "DauysAcl.ps1"; DestDir: "{app}\helpers"; Flags: ignoreversion
Source: "Prepare-DauysUpgrade.ps1"; DestDir: "{app}\helpers"; Flags: ignoreversion

[Icons]
Name: "{group}\Dauys"; Filename: "{app}\bin\dauys-launch.vbs"; WorkingDir: "{app}\bin"; Comment: "Dauys — голосовой агент"
Name: "{userdesktop}\Dauys"; Filename: "{app}\bin\dauys-launch.vbs"; WorkingDir: "{app}\bin"; Tasks: desktopicon
Name: "{userstartup}\DauysAgent"; Filename: "{app}\bin\dauys-launch.vbs"; WorkingDir: "{app}\bin"; Tasks: autostart

[Run]
Filename: "{app}\bin\dauys-launch.vbs"; Description: "Запустить Dauys"; Flags: nowait postinstall skipifsilent shellexec

[Code]
const
  UpgradeExtractDir = 'dauys-upgrade';
  UpgradePrepareScript = 'Prepare-DauysUpgrade.ps1';
  UpgradeAclScript = 'DauysAcl.ps1';

var
  UpgradePrepareDone: Boolean;

function UpgradeLogPathTmp(): string;
begin
  Result := ExpandConstant('{tmp}\dauys-upgrade-prepare.log');
end;

function UpgradeLogPathApp(): string;
begin
  Result := ExpandConstant('{localappdata}\DauysAgent\upgrade-prepare.log');
end;

procedure AppendUpgradeLog(const Line: string);
var
  TmpLog, AppLog, AppDir, Full: string;
begin
  Full := GetDateTimeString('yyyy-mm-dd"T"hh:nn:ss', '-', ':') + 'Z inno ' + Line;
  Log('DauysUpgrade: ' + Line);
  TmpLog := UpgradeLogPathTmp();
  if not SaveStringToFile(TmpLog, Full + #13#10, True) then
    Log('DauysUpgrade: cannot write tmp log: ' + TmpLog);
  AppDir := ExpandConstant('{localappdata}\DauysAgent');
  if ForceDirectories(AppDir) then
  begin
    AppLog := UpgradeLogPathApp();
    // Best-effort: root ACL may block; tmp log is authoritative for Setup diagnostics.
    if not SaveStringToFile(AppLog, Full + #13#10, True) then
      Log('DauysUpgrade: cannot write app log (ACL?): ' + AppLog);
  end;
end;

function UpgradeScriptDir(): string;
begin
  Result := ExpandConstant('{tmp}\' + UpgradeExtractDir);
end;

function UpgradePreparePath(): string;
begin
  Result := UpgradeScriptDir() + '\' + UpgradePrepareScript;
end;

function UpgradeAclPath(): string;
begin
  Result := UpgradeScriptDir() + '\' + UpgradeAclScript;
end;

function ExtractUpgradeScripts(): Boolean;
var
  N: Integer;
  Prep, Acl: string;
  PrepSize, AclSize: Integer;
begin
  Result := False;
  Prep := UpgradePreparePath();
  Acl := UpgradeAclPath();
  AppendUpgradeLog('extract_begin pattern=' + UpgradeExtractDir + '\*');
  try
    N := ExtractTemporaryFiles(UpgradeExtractDir + '\*');
  except
    AppendUpgradeLog('extract_exception=' + GetExceptionMessage);
    MsgBox(
      'Не удалось извлечь скрипты подготовки обновления из установщика.' + #13#10 +
      'ExtractTemporaryFiles failed.' + #13#10#13#10 +
      'Журнал: ' + UpgradeLogPathTmp(),
      mbError, MB_OK);
    exit;
  end;
  AppendUpgradeLog('extract_count=' + IntToStr(N));
  if N < 2 then
  begin
    AppendUpgradeLog('extract_fail reason=count_lt_2');
    MsgBox(
      'В установщике нет скриптов dauys-upgrade (ExtractTemporaryFiles вернул ' +
      IntToStr(N) + ').' + #13#10 +
      'Пересоберите DauysSetup-x64.exe из ветки Windows.' + #13#10#13#10 +
      'Журнал: ' + UpgradeLogPathTmp(),
      mbError, MB_OK);
    exit;
  end;
  if not FileExists(Prep) then
  begin
    AppendUpgradeLog('extract_fail missing=' + Prep);
    MsgBox(
      'После извлечения нет файла:' + #13#10 + Prep + #13#10#13#10 +
      'Журнал: ' + UpgradeLogPathTmp(),
      mbError, MB_OK);
    exit;
  end;
  if not FileExists(Acl) then
  begin
    AppendUpgradeLog('extract_fail missing=' + Acl);
    MsgBox(
      'После извлечения нет файла:' + #13#10 + Acl + #13#10#13#10 +
      'Журнал: ' + UpgradeLogPathTmp(),
      mbError, MB_OK);
    exit;
  end;
  PrepSize := 0;
  AclSize := 0;
  if not FileSize(Prep, PrepSize) then
    PrepSize := -1;
  if not FileSize(Acl, AclSize) then
    AclSize := -1;
  AppendUpgradeLog('extract_ok prepare_bytes=' + IntToStr(PrepSize) + ' acl_bytes=' + IntToStr(AclSize));
  if (PrepSize <= 0) or (AclSize <= 0) then
  begin
    AppendUpgradeLog('extract_fail reason=zero_size');
    MsgBox(
      'Извлечённые скрипты пустые (0 байт). Установщик собран неверно.' + #13#10 +
      'Журнал: ' + UpgradeLogPathTmp(),
      mbError, MB_OK);
    exit;
  end;
  Result := True;
end;

function RunUpgradePrepare(): Boolean;
var
  ResultCode: Integer;
  Params: string;
  AppRoot: string;
  PsExe: string;
  Prep: string;
begin
  Result := False;
  Prep := UpgradePreparePath();
  AppRoot := ExpandConstant('{app}');
  PsExe := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  if not FileExists(PsExe) then
  begin
    AppendUpgradeLog('powershell_missing=' + PsExe);
    MsgBox('Не найден Windows PowerShell:' + #13#10 + PsExe, mbError, MB_OK);
    exit;
  end;
  Params :=
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Prep +
    '" -Root "' + AppRoot +
    '" -LogPath "' + UpgradeLogPathTmp() + '"';
  AppendUpgradeLog('exec_begin powershell="' + PsExe + '"');
  AppendUpgradeLog('exec_params_len=' + IntToStr(Length(Params)));
  AppendUpgradeLog('exec_script="' + Prep + '" root="' + AppRoot + '"');
  if not Exec(PsExe, Params, UpgradeScriptDir(), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    AppendUpgradeLog('exec_fail Win32/Exec returned false');
    MsgBox(
      'Не удалось запустить подготовку обновления Dauys (Exec).' + #13#10 +
      'Права администратора не нужны.' + #13#10#13#10 +
      'Журнал: ' + UpgradeLogPathTmp() + #13#10 +
      UpgradeLogPathApp(),
      mbError, MB_OK);
    exit;
  end;
  AppendUpgradeLog('exec_exit_code=' + IntToStr(ResultCode));
  if ResultCode <> 0 then
  begin
    AppendUpgradeLog('exec_fail nonzero_exit');
    MsgBox(
      'Подготовка обновления завершилась с ошибкой (код ' + IntToStr(ResultCode) + ').' + #13#10#13#10 +
      '1. Закройте Dauys через значок в трее (Выйти).' + #13#10 +
      '2. Подождите несколько секунд.' + #13#10 +
      '3. Снова запустите этот установщик (без прав администратора).' + #13#10#13#10 +
      'Журнал: ' + UpgradeLogPathTmp() + #13#10 +
      UpgradeLogPathApp(),
      mbError, MB_OK);
    exit;
  end;
  AppendUpgradeLog('exec_ok');
  Result := True;
end;

function PrepareUpgrade(): Boolean;
begin
  Result := False;
  AppendUpgradeLog('marker=UPGRADE_PREPARE_V3 phase=PrepareUpgrade_enter');
  AppendUpgradeLog('tmp=' + ExpandConstant('{tmp}'));
  AppendUpgradeLog('app=' + ExpandConstant('{app}'));
  if not ExtractUpgradeScripts() then
    exit;
  if not RunUpgradePrepare() then
    exit;
  UpgradePrepareDone := True;
  AppendUpgradeLog('phase=PrepareUpgrade_ok');
  Result := True;
end;

procedure PrepareUpgradeOrFail;
begin
  AppendUpgradeLog('phase=BeforeInstall_bin_exe');
  if UpgradePrepareDone then
  begin
    AppendUpgradeLog('phase=BeforeInstall_skip_already_done');
    exit;
  end;
  if not PrepareUpgrade() then
    RaiseException(
      'Подготовка обновления не выполнена — замена dauys-agent.exe отменена.' + #13#10 +
      'Скрипт не запущен или завершился с ошибкой (до DeleteFile).' + #13#10 +
      'Журнал: ' + UpgradeLogPathTmp());
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  NeedsRestart := False;
  Result := '';
  AppendUpgradeLog('phase=PrepareToInstall');
  UpgradePrepareDone := False;
  if not PrepareUpgrade() then
  begin
    Result :=
      'Обновление остановлено до замены dauys-agent.exe:' + #13#10 +
      'не удалось извлечь или запустить Prepare-DauysUpgrade.ps1.' + #13#10 +
      'Журнал: ' + UpgradeLogPathTmp();
    AppendUpgradeLog('phase=PrepareToInstall_abort');
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  VbsPath, ExePath, Content: string;
begin
  if CurStep = ssInstall then
  begin
    AppendUpgradeLog('phase=ssInstall');
    if not UpgradePrepareDone then
    begin
      if not PrepareUpgrade() then
        RaiseException(
          'ssInstall: подготовка обновления не выполнена. Журнал: ' + UpgradeLogPathTmp());
    end;
  end;
  if CurStep = ssPostInstall then
  begin
    AppendUpgradeLog('phase=ssPostInstall');
    ExePath := ExpandConstant('{app}\bin\{#MyAppExeName}');
    VbsPath := ExpandConstant('{app}\bin\dauys-launch.vbs');
    Content :=
      'Set sh = CreateObject("WScript.Shell")' + #13#10 +
      'sh.Run """' + ExePath + '""", 0, False' + #13#10;
    SaveStringToFile(VbsPath, Content, False);
  end;
end;

function InitializeSetup(): Boolean;
begin
  UpgradePrepareDone := False;
  Result := True;
  Log('DauysUpgrade: InitializeSetup (SetupLogging=yes)');
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  if not UninstallSilent then
  begin
    if MsgBox('Удалить также настройки и привязку телефона?' + #13#10 +
              'Да — полный сброс. Нет — сохранить токен и настройки.',
              mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      RegWriteStringValue(HKCU, 'Software\DauysAgent', 'PurgeOnUninstall', '1')
    else
      RegWriteStringValue(HKCU, 'Software\DauysAgent', 'PurgeOnUninstall', '0');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Purge: string;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Purge := '';
    RegQueryStringValue(HKCU, 'Software\DauysAgent', 'PurgeOnUninstall', Purge);
    if Purge = '1' then
      DelTree(ExpandConstant('{localappdata}\DauysAgent'), True, True, True)
    else
    begin
      DelTree(ExpandConstant('{app}\bin'), True, True, True);
      DelTree(ExpandConstant('{app}\helpers'), True, True, True);
    end;
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\DauysAgent');
    DeleteFile(ExpandConstant('{userstartup}\DauysAgent.lnk'));
  end;
end;
