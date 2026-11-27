; Inno Setup script for Raikasa. Built by build.ps1 from the self-contained publish output. build.ps1 passes the product
; name from Directory.Build.props as /DAppName, so the name below is only the default for a direct ISCC run.

#ifndef AppVersion
  #define AppVersion "2.0.0"
#endif

#ifndef AppName
  #define AppName "Raikasa"
#endif
#define AppExeName AppName + ".exe"
#define AppPublisher "Luka Stojiljkovic"
#define AppUrl "https://github.com/lukastojiljkovic/" + AppName
#define PublishDir "..\artifacts\publish\win-x64"

[Setup]
; The AppId never changes, so that an upgrade replaces the installed version instead of installing beside it.
AppId={{C702E743-6E7D-4276-9FDB-DB7B6FFC181A}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\{#AppName}
DisableDirPage=auto
DisableProgramGroupPage=yes
; Users must accept the Terms of Use, which also cover the redistributed Microsoft components.
LicenseFile=..\TERMS.md
OutputDir=..\artifacts\installer
OutputBaseFilename={#AppName}-{#AppVersion}-Setup
SetupIconFile=..\src\{#AppName}\Assets\{#AppName}.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
; Raikasa starts its own exe as administrator, so it must live where only administrators can replace it.
PrivilegesRequired=admin
; Closes every running copy before its files are replaced: the window and its elevated helper, which are the same exe,
; and a version from before the rename, whose exe has another name but loads the same runtime DLLs.
CloseApplications=yes
CloseApplicationsFilter=*.exe,*.dll

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Excludes: "*.pdb"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
Source: "..\TERMS.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\PRIVACY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\THIRD-PARTY-NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallRun]
; Removes the reminder task, the notification registration, the settings and the history. They belong to the account
; that approves the uninstaller, which is the signed-in user in the usual case of an administrator account.
Filename: "{app}\{#AppExeName}"; Parameters: "--uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveUserData"

[Code]
const
  DirectoryAttribute = $10;
  ReparsePointAttribute = $400;

// The version from before the rename created its shortcuts under its own name, which this version doesn't replace.
// Deletes one of them if it is a plain file: never a folder, and never a link, which stays as it is.
procedure DeletePreviousShortcut(const Path: String);
var
  Entry: TFindRec;
  PlainFile: Boolean;
begin
  if not FindFirst(Path, Entry) then
    Exit;
  try
    PlainFile := (Entry.Attributes and (DirectoryAttribute or ReparsePointAttribute)) = 0;
  finally
    FindClose(Entry);
  end;
  if not PlainFile then
    Log('Left ' + Path + ', which is not a plain file.')
  else if DeleteFile(Path) then
    Log('Deleted the previous shortcut ' + Path + '.')
  else
    Log('Could not delete the previous shortcut ' + Path + '.');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    DeletePreviousShortcut(ExpandConstant('{commonprograms}\Refreshify.lnk'));
    DeletePreviousShortcut(ExpandConstant('{commondesktop}\Refreshify.lnk'));
  end;
end;
