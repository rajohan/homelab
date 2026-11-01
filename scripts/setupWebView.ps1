param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../deploy/computer/webview2.json') -Raw | ConvertFrom-Json
if ($config.version -notmatch '^1\.0\.\d+\.\d+$') { throw 'Invalid WebView2 SDK version.' }
$target = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $target -Force | Out-Null
$download = Join-Path $target 'webview2.nupkg'
try {
    Invoke-WebRequest -UseBasicParsing -Uri ('https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/' + $config.version + '/microsoft.web.webview2.' + $config.version + '.nupkg') -OutFile $download
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.sha256) { throw 'WebView2 SDK checksum mismatch.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($download)
    try {
        $files = @{
            'lib/net462/Microsoft.Web.WebView2.Core.dll' = 'Microsoft.Web.WebView2.Core.dll'
            'lib/net462/Microsoft.Web.WebView2.WinForms.dll' = 'Microsoft.Web.WebView2.WinForms.dll'
            'build/native/x64/WebView2Loader.dll' = 'WebView2Loader.dll'
            'LICENSE.txt' = 'WebView2-LICENSE.txt'
        }
        foreach ($name in $files.Keys) {
            $entry = $archive.GetEntry($name)
            if (!$entry -or $entry.Length -gt 2097152) { throw 'Invalid SDK member.' }
            $file = Join-Path $target $files[$name]
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $file, $true)
            if ($file.EndsWith('.dll')) {
                $signature = Get-AuthenticodeSignature -LiteralPath $file
                if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -ne $config.publisher) { throw 'WebView2 publisher mismatch.' }
            }
        }
    } finally { $archive.Dispose() }
} finally { if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download } }
