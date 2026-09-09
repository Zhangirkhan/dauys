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
Source: "{#SourceAgentDir}\dauys-agent.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "{#SourceAgentDir}\DauysAcl.ps1"; DestDir: "{app}\helpers"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
Name: "{group}\Dauys"; Filename: "{app}\bin\dauys-launch.vbs"; WorkingDir: "{app}\bin"; Comment: "Dauys — голосовой агент"
Name: "{userdesktop}\Dauys"; Filename: "{app}\bin\dauys-launch.vbs"; WorkingDir: "{app}\bin"; Tasks: desktopicon
Name: "{userstartup}\DauysAgent"; Filename: "{app}\bin\dauys-launch.vbs"; WorkingDir: "{app}\bin"; Tasks: autostart

[Run]
Filename: "{app}\bin\dauys-launch.vbs"; Description: "Запустить Dauys"; Flags: nowait postinstall skipifsilent shellexec

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  VbsPath, ExePath, Content: string;
begin
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
