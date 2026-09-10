; Dauys Windows agent — per-user installer (no admin)
; Built by: pnpm build:agent:windows-installer

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
Compression=lzma2
SolidCompression=yes
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
; Подготовка обновления: остановить агент + ACL bin/helpers (не копируется в {app})
Source: "DauysAcl.ps1"; Flags: dontcopy noencryption
Source: "Prepare-DauysUpgrade.ps1"; Flags: dontcopy noencryption
Source: "{#SourceAgentDir}\dauys-agent.exe"; DestDir: "{app}\bin"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceAgentDir}\DauysAcl.ps1"; DestDir: "{app}\helpers"; Flags: ignoreversion skipifsourcedoesntexist
Source: "Prepare-DauysUpgrade.ps1"; DestDir: "{app}\helpers"; Flags: ignoreversion

[Icons]
Name: "{group}\Dauys"; Filename: "{app}\bin\dauys-launch.vbs"; WorkingDir: "{app}\bin"; Comment: "Dauys — голосовой агент"
Name: "{userdesktop}\Dauys"; Filename: "{app}\bin\dauys-launch.vbs"; WorkingDir: "{app}\bin"; Tasks: desktopicon
Name: "{userstartup}\DauysAgent"; Filename: "{app}\bin\dauys-launch.vbs"; WorkingDir: "{app}\bin"; Tasks: autostart

[Run]
Filename: "{app}\bin\dauys-launch.vbs"; Description: "Запустить Dauys"; Flags: nowait postinstall skipifsilent shellexec

[Code]
function PrepareUpgrade(): Boolean;
var
  ResultCode: Integer;
  Params: string;
  AppRoot: string;
begin
  Result := False;
  ExtractTemporaryFile('DauysAcl.ps1');
  ExtractTemporaryFile('Prepare-DauysUpgrade.ps1');
  AppRoot := ExpandConstant('{app}');
  Params :=
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\Prepare-DauysUpgrade.ps1') +
    '" -Root "' + AppRoot + '"';
  if not Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Params,
    ExpandConstant('{tmp}'),
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  ) then
  begin
    MsgBox(
      'Не удалось запустить подготовку обновления Dauys.' + #13#10 +
      'Права администратора не нужны. Повторите установку.',
      mbError,
      MB_OK
    );
    exit;
  end;
  if ResultCode <> 0 then
  begin
    MsgBox(
      'Не удалось освободить файл dauys-agent.exe для обновления.' + #13#10#13#10 +
      '1. Закройте Dauys через значок в трее (Выйти).' + #13#10 +
      '2. Подождите несколько секунд.' + #13#10 +
      '3. Снова запустите этот установщик (без прав администратора).' + #13#10#13#10 +
      'Если ошибка повторяется: Параметры → Приложения → Dauys → Удалить' + #13#10 +
      '(можно сохранить настройки), затем установите заново.',
      mbError,
      MB_OK
    );
    exit;
  end;
  Result := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  NeedsRestart := False;
  Result := '';
  if not PrepareUpgrade() then
    Result :=
      'Обновление отменено: файл dauys-agent.exe занят или недоступен.' + #13#10 +
      'Закройте Dauys из трея и повторите установку.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  VbsPath, ExePath, Content: string;
begin
  if CurStep = ssInstall then
  begin
    { Повторная подготовка непосредственно перед копированием файлов }
    if not PrepareUpgrade() then
      RaiseException(
        'Не удалось подготовить замену dauys-agent.exe. Закройте Dauys из трея и повторите.'
      );
  end;
  if CurStep = ssPostInstall then
  begin
    ExePath := ExpandConstant('{app}\bin\{#MyAppExeName}');
    VbsPath := ExpandConstant('{app}\bin\dauys-launch.vbs');
    Content :=
      'Set sh = CreateObject("WScript.Shell")' + #13#10 +
      'sh.Run """' + ExePath + '""", 0, False' + #13#10;
    SaveStringToFile(VbsPath, Content, False);
  end;
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
