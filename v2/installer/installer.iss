#ifndef PackageRoot
  #error PackageRoot is required
#endif
#ifndef ReleaseTag
  #error ReleaseTag is required
#endif
[Setup]
AppId={{EA9EB1B6-11FF-4D0B-90BA-CAA51A05705E}
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
UninstallDisplayIcon={app}\CatCut-v2.exe

[Tasks]
Name: desktopicon; Description: Create a desktop shortcut; Flags: unchecked

[Files]
Source: "{#PackageRoot}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\CatCut"; Filename: "{app}\CatCut-v2.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\CatCut"; Filename: "{app}\CatCut-v2.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\CatCut-v2.exe"; Description: "Start CatCut"; Flags: nowait postinstall skipifsilent
Filename: "{app}\CatCut-v2.exe"; Flags: nowait skipifnotsilent
