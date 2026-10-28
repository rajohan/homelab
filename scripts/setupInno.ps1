param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../deploy/computer/inno.json') -Raw | ConvertFrom-Json
$target = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $target) { throw 'Compiler destination must be new.' }
New-Item -ItemType Directory -Path $target | Out-Null
$download = Join-Path $target 'inno-setup.exe'
Invoke-WebRequest -Uri $config.url -OutFile $download
if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.sha256) { throw 'Compiler checksum mismatch.' }
$signature = Get-AuthenticodeSignature -LiteralPath $download
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -ne $config.publisher) { throw 'Compiler publisher mismatch.' }
$portable = Join-Path $target 'portable'
$result = Start-Process -FilePath $download -ArgumentList @('/PORTABLE=1', '/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', ('/DIR="' + $portable + '"')) -WindowStyle Hidden -Wait -PassThru
if ($result.ExitCode -ne 0 -or !(Test-Path -LiteralPath (Join-Path $portable 'ISCC.exe'))) { throw 'Portable compiler setup failed.' }
Write-Output (Join-Path $portable 'ISCC.exe')
