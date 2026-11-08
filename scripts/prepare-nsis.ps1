param(
    [string]$CacheRoot = (Join-Path $env:LOCALAPPDATA 'tauri'),
    [string]$TemporaryDirectory = $env:TEMP
)
$ErrorActionPreference = 'Stop'
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
$tools = [IO.Path]::GetFullPath((Join-Path $CacheRoot 'NSIS'))
$zip = Join-Path $TemporaryDirectory 'mavyn-nsis-3.13.zip'
$utility = Join-Path $TemporaryDirectory 'mavyn-nsis-utils-0.5.3.dll'
function Download-Verified([string]$Url, [string]$Path, [string]$Sha256, [string]$Sha1) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Invoke-WebRequest -Uri $Url -Headers @{ Accept = 'application/octet-stream'; 'User-Agent' = 'Mavyn-build' } -OutFile $Path -TimeoutSec 45
            if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Sha256 -or
                (Get-FileHash -LiteralPath $Path -Algorithm SHA1).Hash -ne $Sha1) {
                throw 'Downloaded build tool does not match the pinned Tauri release.'
            }
            return
        } catch { if ($attempt -eq 3) { throw }; Start-Sleep -Seconds 2 }
    }
}
# Exact versions/hashes expected by the pinned Tauri CLI; no verification is disabled.
# GitHub's asset API avoids the browser-download route that returned HTTP 504 in Actions.
Download-Verified 'https://api.github.com/repos/tauri-apps/binary-releases/releases/assets/623832696' $zip `
    'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8' 'DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E'
Download-Verified 'https://api.github.com/repos/tauri-apps/nsis-tauri-utils/releases/assets/345882097' $utility `
    '5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709' '75197FEE3C6A814FE035788D1C34EAD39349B860'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    foreach ($entry in $archive.Entries) {
        if (!$entry.FullName.StartsWith('nsis-3.13/')) { throw 'Unexpected NSIS archive root.' }
        $relative = $entry.FullName.Substring('nsis-3.13/'.Length)
        if (!$relative) { continue }
        $destination = [IO.Path]::GetFullPath((Join-Path $tools $relative))
        if (!$destination.StartsWith($tools + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe build-tool archive path.' }
        if ($entry.FullName.EndsWith('/')) {
            New-Item -ItemType Directory -Force -Path $destination | Out-Null
        } else {
            New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
        }
    }
} finally { $archive.Dispose() }
$plugins = Join-Path $tools 'Plugins/x86-unicode/additional'
New-Item -ItemType Directory -Force -Path $plugins | Out-Null
Copy-Item -LiteralPath $utility -Destination (Join-Path $plugins 'nsis_tauri_utils.dll')
if ((Get-FileHash -LiteralPath (Join-Path $tools 'NSIS.exe') -Algorithm SHA1).Hash -ne '6D45D4E8CCF18FE1FDAC9164058F356102A2ECF2') { throw 'Unexpected NSIS executable.' }
Write-Output 'Prepared the checksum-verified NSIS 3.13 toolchain and Tauri utility 0.5.3.'
