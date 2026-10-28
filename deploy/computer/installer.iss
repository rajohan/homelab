; Built only from the exact, qualified Windows payload. No downloads or elevation.
#define Version "@VERSION@"
[Setup]
AppId={{52017324-6EBD-4BE6-A1EC-833EBDB364F7}
AppName=Mira
AppVersion={#Version}
AppPublisher=Homelab
AppPublisherURL=https://github.com/rajohan/homelab
DefaultDirName={localappdata}\Programs\Homelab\MiraComputer
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
SetupArchitecture=x64
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0
WizardStyle=modern dark polar
SetupIconFile=@ICON@
UninstallDisplayIcon={app}\versions\{#Version}\mira-computer-desktop.exe
OutputDir=@OUTPUT@
OutputBaseFilename=mira-computer-{#Version}-windows-x64-setup
Compression=lzma2/fast
SolidCompression=yes
CloseApplications=no
RestartApplications=no
UninstallLogging=yes
DisableWelcomePage=no
UsePreviousAppDir=no
UsePreviousTasks=yes

[Tasks]
Name: "startup"; Description: "Start Mira in the tray and connect when I sign in"; Flags: unchecked

[Files]
#include "@FILES@"

[Icons]
Name: "{userprograms}\Homelab\Mira"; Filename: "{app}\versions\{#Version}\mira-computer-desktop.exe"; WorkingDir: "{app}\versions\{#Version}"
Name: "{userstartup}\Homelab Mira"; Filename: "{app}\versions\{#Version}\mira-computer-desktop.exe"; Parameters: "--startup"; WorkingDir: "{app}\versions\{#Version}"; Tasks: startup

[InstallDelete]
Type: files; Name: "{userstartup}\Homelab Mira.lnk"; Tasks: not startup

[Code]
var
  Maintenance: THandle;
  ExpectedPaths, ExpectedHashes: TArrayOfString;

function NativeCreateFile(Name: String; Access, Share: Cardinal; Security: NativeInt;
  Creation, Flags: Cardinal; Template: THandle): THandle;
  external 'CreateFileW@kernel32.dll stdcall';
function NativeCloseHandle(Handle: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';
function Attributes(Name: String): Cardinal;
  external 'GetFileAttributesW@kernel32.dll stdcall';
function DriveType(Root: String): Cardinal;
  external 'GetDriveTypeW@kernel32.dll stdcall';

procedure CheckLocalPath(Name: String);
var Parent: String; Attr: Cardinal;
begin
  Name := RemoveBackslashUnlessRoot(ExpandFileName(Name));
  if (Length(Name) < 3) or (Name[2] <> ':') or (DriveType(Copy(Name, 1, 3)) <> 3) then
    RaiseException('Mira requires an ordinary local drive.');
  repeat
    Attr := Attributes(Name);
    if (Attr <> $FFFFFFFF) and ((Attr and FILE_ATTRIBUTE_REPARSE_POINT) <> 0) then
      RaiseException('Mira cannot use linked installation paths.');
    Parent := RemoveBackslashUnlessRoot(ExtractFileDir(Name));
    if CompareText(Parent, Name) = 0 then Break;
    Name := Parent;
  until Length(Name) < 3;
end;

procedure AcquireMaintenance;
var Directory, LockFile: String;
begin
  if Maintenance <> 0 then Exit;
  Directory := ExpandConstant('{localappdata}\Homelab\MiraComputer');
  CheckLocalPath(Directory);
  if not ForceDirectories(Directory) then RaiseException('Could not open Mira installation state.');
  LockFile := Directory + '\installation.lock';
  CheckLocalPath(LockFile);
  { Exclusive, non-inheritable, OPEN_ALWAYS; runtime readers hold the same file. }
  Maintenance := NativeCreateFile(LockFile, $C0000000, 0, 0, 4, $00200000, 0);
  if Maintenance = THandle(-1) then begin
    Maintenance := 0;
    RaiseException('Exit Mira from the system tray and stop any Mira command-line clients, then try again.');
  end;
end;

procedure ReleaseMaintenance;
begin
  if Maintenance <> 0 then begin NativeCloseHandle(Maintenance); Maintenance := 0; end;
end;

procedure CheckTree(Directory: String; Relative: String; KnownOnly: Boolean);
var Item: TFindRec; Name: String; Index: Integer; Found: Boolean;
begin
  CheckLocalPath(Directory);
  if not DirExists(Directory) then Exit;
  if FindFirst(Directory + '\*', Item) then begin
    try
      repeat
        if (Item.Name <> '.') and (Item.Name <> '..') then begin
          Name := Relative + Item.Name;
          if (Item.Attributes and FILE_ATTRIBUTE_REPARSE_POINT) <> 0 then
            RaiseException('Mira cannot modify linked package files.');
          if (Item.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
            CheckTree(Directory + '\' + Item.Name, Name + '\', KnownOnly)
          else if KnownOnly then begin
            Found := False;
            for Index := 0 to GetArrayLength(ExpectedPaths) - 1 do
              if CompareText(Name, ExpectedPaths[Index]) = 0 then begin
                Found := True;
                if CompareText(GetSHA256OfFile(Directory + '\' + Item.Name), ExpectedHashes[Index]) <> 0 then
                  RaiseException('This version has modified files. Uninstall it before reinstalling.');
                Break;
              end;
            if not Found then RaiseException('This version contains unexpected files. Uninstall it before reinstalling.');
          end;
        end;
      until not FindNext(Item);
    finally FindClose(Item); end;
  end;
end;

procedure LoadInventory;
begin
#include "@INVENTORY@"
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  try
    if CompareText(RemoveBackslashUnlessRoot(ExpandFileName(ExpandConstant('{app}'))),
      ExpandConstant('{localappdata}\Programs\Homelab\MiraComputer')) <> 0 then
      RaiseException('Mira installs only in the current user''s Programs folder.');
    AcquireMaintenance;
    LoadInventory;
    CheckTree(ExpandConstant('{app}'), '', False);
    CheckTree(ExpandConstant('{app}\versions\{#Version}'), '', True);
  except
    Result := GetExceptionMessage;
    ReleaseMaintenance;
  end;
end;

function InitializeUninstall: Boolean;
begin
  Result := False;
  try
    AcquireMaintenance;
    CheckTree(ExpandConstant('{app}'), '', False);
    Result := True;
  except
    Log(GetExceptionMessage);
    if not UninstallSilent then MsgBox(GetExceptionMessage, mbError, MB_OK);
    ReleaseMaintenance;
  end;
end;

procedure DeinitializeSetup;
begin ReleaseMaintenance; end;

procedure DeinitializeUninstall;
begin ReleaseMaintenance; end;
