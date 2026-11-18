#ifndef PackageRoot
  #error PackageRoot is required
#endif
#ifndef ReleaseTag
  #error ReleaseTag is required
#endif
[Setup]
#ifdef TestBuild
AppId={{55A11C45-6EAF-4F6A-BDC7-EB299071A26C}
#else
AppId={{D2E2F599-EE03-4A91-8C44-3059A7A8D6CE}
#endif
AppName=CatCut
AppVersion={#ReleaseTag}
AppPublisher=CatCut
AppPublisherURL=https://github.com/FINAGOUS/catcut
DefaultDirName={localappdata}\Programs\CatCut
DefaultGroupName=CatCut
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#PackageRoot}\..\installer-output
OutputBaseFilename=CatCut-{#ReleaseTag}-setup-x64
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=yes
UninstallDisplayIcon={app}\Windows\bin\CatCut.exe

[Tasks]
Name: desktopicon; Description: Create a desktop shortcut; Flags: unchecked

[Files]
Source: "{#PackageRoot}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\CatCut"; Filename: "{app}\Windows\bin\CatCut.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\CatCut"; Filename: "{app}\Windows\bin\CatCut.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
#ifndef TestBuild
Filename: "{app}\Windows\bin\CatCut.exe"; Description: "Start CatCut"; Flags: nowait postinstall skipifsilent
Filename: "{app}\Windows\bin\CatCut.exe"; Flags: nowait skipifnotsilent
#endif

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    SaveStringToFile(ExpandConstant('{app}\Windows\installed.flag'), 'installed', False);
end;
