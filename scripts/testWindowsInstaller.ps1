param(
    [Parameter(Mandatory=$true)][string]$Setup,
    [Parameter(Mandatory=$true)][string]$Upgrade,
    [Parameter(Mandatory=$true)][string]$Manifest,
    [Parameter(Mandatory=$true)][string]$UpgradeVersion,
    [Parameter(Mandatory=$true)][string]$Workspace,
    [Parameter(Mandatory=$true)][string]$UpdateHelper
)
$ErrorActionPreference = 'Stop'
# Real installation belongs only on an ephemeral hosted runner, never a developer's PC.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Installer qualification requires a disposable GitHub-hosted Windows runner.'
}
$metadata = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$local = [Environment]::GetFolderPath('LocalApplicationData')
$programs = [Environment]::GetFolderPath('Programs')
$root = Join-Path $local 'Programs/Homelab/MiraComputer'
$state = Join-Path $local 'Homelab/MiraComputer'
$shortcut = Join-Path $programs 'Homelab/Mira.lnk'
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{52017324-6EBD-4BE6-A1EC-833EBDB364F7}_is1'
foreach ($entry in @($root, $state, $shortcut, $registry)) {
    if (Test-Path -LiteralPath $entry) { throw 'Runner already has Mira state; refusing to modify it.' }
}
$count = 0
$lease = $null
function Require([bool]$Condition, [string]$Message) {
    $script:count++
    if (!$Condition) { throw $Message }
}
function File-Digest([string]$File) {
    # Windows PowerShell can inherit PowerShell 7's module path on hosted runners.
    # Use the platform crypto API without depending on an autoloaded hash cmdlet.
    $stream = [IO.File]::OpenRead($File)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}
function Run-Setup([string]$Executable, [bool]$Success, [string]$Name) {
    $log = Join-Path $Workspace ($Name + '.log')
    # Inno's uninstaller hands cleanup to a descendant. -Wait waits the whole
    # process tree; Process.WaitForExit only waits the initial executable.
    # The caller bounds the complete qualification process to five minutes.
    $child = Start-Process -FilePath $Executable -ArgumentList @('/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', ('/LOG="' + $log + '"')) -WindowStyle Hidden -Wait -PassThru
    Write-Output ("Installer step: " + $Name + ', exit ' + $child.ExitCode)
    Require (($child.ExitCode -eq 0) -eq $Success) ("Unexpected installer outcome for " + $Name + ': ' + $child.ExitCode)
    if (!$Success) {
        Require ((Get-Content -LiteralPath $log -Raw) -match 'Exit Mira|modified files|unexpected files|linked') 'Expected a specific safe refusal.'
    }
}
function Run-NativeUpgrade {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $UpdateHelper
    $info.Arguments = '--qualify-update "' + $Workspace + '"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($info)
    try {
        $output = $child.StandardOutput.ReadToEndAsync()
        $errors = $child.StandardError.ReadToEndAsync()
        $receipt = @{ repository='demo/homelab'; version=$UpgradeVersion; revision=('a' * 40); size=[int](Get-Item -LiteralPath $Upgrade).Length; sha256=(File-Digest $Upgrade); validForMs=300000 }
        $header = [Text.Encoding]::ASCII.GetBytes(($receipt | ConvertTo-Json -Compress) + "`n")
        $child.StandardInput.BaseStream.Write($header, 0, $header.Length)
        $inputFile = [IO.File]::OpenRead($Upgrade)
        try { $inputFile.CopyTo($child.StandardInput.BaseStream) } finally { $inputFile.Dispose() }
        $child.StandardInput.Close()
        Require ($child.WaitForExit(120000)) 'Native updater did not finish.'
        Require ($child.ExitCode -eq 0) ('Native update failed: ' + $errors.Result)
        Require ($output.Result -match 'Native update installation completed.') 'Native update confirmation is missing.'
        Require ((Get-ChildItem -LiteralPath $Workspace -Directory -Filter 'mira-update-*').Count -eq 0) 'Native update left staging files.'
    } finally { $child.Dispose() }
}
function Check-Payload([string]$Version) {
    $directory = Join-Path $root ('versions/' + $Version)
    foreach ($file in $metadata.files) {
        $installed = Join-Path $directory $file.path
        Require ((File-Digest $installed) -eq $file.sha256) 'Installed file mismatch.'
    }
    Require ((Get-ChildItem -LiteralPath $directory -File -Recurse).Count -eq $metadata.files.Count) 'Unexpected installed files.'
    $shell = New-Object -ComObject WScript.Shell
    try { Require ($shell.CreateShortcut($shortcut).TargetPath -eq [IO.Path]::GetFullPath((Join-Path $directory 'mira-computer-desktop.exe'))) 'Start menu points to another version.' }
    finally { [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null }
    $check = Start-Process -FilePath (Join-Path $directory 'mira-computer-desktop.exe') -ArgumentList '--check-package' -WindowStyle Hidden -PassThru -Wait
    Require ($check.ExitCode -eq 0) 'Installed package check failed.'
}
function Open-Lease {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $root ('versions/' + $metadata.version + '/mira-computer-desktop.exe')
    $info.Arguments = '--installation-lease'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($info)
    try {
        $child.StandardInput.WriteLine('{"id":1,"method":"initialize","params":{}}')
        $child.StandardInput.Flush()
        $response = $child.StandardOutput.ReadLineAsync()
        Require ($response.Wait(5000) -and $response.Result -match '"protocol":1') 'Lease did not initialize.'
        return $child
    } catch { if (!$child.HasExited) { $child.Kill() }; $child.Dispose(); throw }
}
function Close-Lease {
    if ($script:lease) {
        $script:lease.StandardInput.Close()
        Require ($script:lease.WaitForExit(5000) -and $script:lease.ExitCode -eq 0) 'Lease cleanup failed.'
        $script:lease.Dispose()
        $script:lease = $null
    }
}
try {
    Run-Setup $Setup $true 'fresh'
    Check-Payload $metadata.version
    Require (Test-Path -LiteralPath $registry) 'Missing user-scoped uninstall entry.'
    # Installation must not enroll, connect, add startup entries or create credentials.
    Require (!(Test-Path -LiteralPath (Join-Path $state 'server.txt'))) 'Installer created connection preferences.'
    $lease = Open-Lease
    Run-Setup $Upgrade $false 'busy-upgrade'
    Run-Setup (Join-Path $root 'unins000.exe') $false 'busy-uninstall'
    Require (!(Test-Path -LiteralPath (Join-Path $root ('versions/' + $UpgradeVersion)))) 'Busy upgrade wrote its payload.'
    Check-Payload $metadata.version
    Close-Lease
    # Repair accepts byte-identical files, but never overwrites altered code.
    Run-Setup $Setup $true 'repair'
    $changed = Join-Path $root ('versions/' + $metadata.version + '/mira-computer-desktop.exe')
    $original = [IO.File]::ReadAllBytes($changed)
    [IO.File]::WriteAllText($changed, 'synthetic modified file')
    Run-Setup $Setup $false 'modified'
    Require ([IO.File]::ReadAllText($changed) -eq 'synthetic modified file') 'Installer overwrote modified code.'
    [IO.File]::WriteAllBytes($changed, $original)
    $extra = Join-Path $root ('versions/' + $metadata.version + '/unexpected.dll')
    [IO.File]::WriteAllText($extra, 'fixture')
    Run-Setup $Setup $false 'extra'
    Remove-Item -LiteralPath $extra
    Run-NativeUpgrade
    Check-Payload $UpgradeVersion
    Require (Test-Path -LiteralPath $changed) 'Upgrade rewrote the old version in place.'
    $preserved = Join-Path $state 'qualification-preferences.txt'
    [IO.File]::WriteAllText($preserved, 'synthetic preference')
    Run-Setup (Join-Path $root 'unins000.exe') $true 'uninstall'
    Require (!(Test-Path -LiteralPath $root)) 'Uninstaller left program files.'
    Require (!(Test-Path -LiteralPath $shortcut)) 'Uninstaller left its shortcut.'
    Require (!(Test-Path -LiteralPath $registry)) 'Uninstaller left its registration.'
    Require ([IO.File]::ReadAllText($preserved) -eq 'synthetic preference') 'Uninstaller deleted user state.'
    Write-Output ("Windows installer qualification passed: " + $count + ' assertions')
} finally {
    if ($lease) { if (!$lease.HasExited) { $lease.Kill() }; $lease.WaitForExit(5000) | Out-Null; $lease.Dispose() }
    # Remaining files belong to this disposable runner; never recursively remove a computed user path here.
}
