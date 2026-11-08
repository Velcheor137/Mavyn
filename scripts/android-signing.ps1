param(
    [ValidateSet('Init', 'Build')][string]$Action = 'Build',
    [string]$SigningDirectory = "$env:LOCALAPPDATA/Mavyn/signing",
    [string]$JavaHome = "$env:ProgramFiles/Android/Android Studio/jbr",
    [string]$WslEnvironment,
    [string[]]$Targets = @('aarch64'),
    [int]$VersionCode = 0
)
$ErrorActionPreference = 'Stop'
$SigningDirectory = [IO.Path]::GetFullPath($SigningDirectory)
$keyFile = Join-Path $SigningDirectory 'release.p12'
$secretFile = Join-Path $SigningDirectory 'password.dpapi'
if ($Action -eq 'Init') {
    if ((Test-Path -LiteralPath $keyFile) -or (Test-Path -LiteralPath $secretFile)) { throw 'Signing identity already exists; never replace it for an upgrade.' }
    New-Item -ItemType Directory -Force -Path $SigningDirectory | Out-Null
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $SigningDirectory /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict signing directory access.' }
    $random = New-Object byte[] 48
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($random) } finally { $rng.Dispose() }
    $env:MAVYN_KEYSTORE_PASSWORD = [Convert]::ToBase64String($random)
    try {
        $secure = ConvertTo-SecureString $env:MAVYN_KEYSTORE_PASSWORD -AsPlainText -Force
        $secure | ConvertFrom-SecureString | Set-Content -LiteralPath $secretFile -Encoding ASCII
        & "$JavaHome/bin/keytool.exe" -genkeypair -keystore $keyFile -storetype PKCS12 -alias mavyn-release -keyalg RSA -keysize 4096 -validity 10000 -dname 'CN=Mavyn Android Release' -storepass:env MAVYN_KEYSTORE_PASSWORD -keypass:env MAVYN_KEYSTORE_PASSWORD -noprompt
        if ($LASTEXITCODE -ne 0) { throw 'Key generation failed; inspect the signing directory before retrying.' }
    } finally { Remove-Item Env:MAVYN_KEYSTORE_PASSWORD -ErrorAction SilentlyContinue }
    Write-Output "Created signing identity at $SigningDirectory. Password is protected with Windows DPAPI for this user on this machine. Back up before distribution; see docs/releases.md."
    exit
}
if (!(Test-Path -LiteralPath $keyFile) -or !(Test-Path -LiteralPath $secretFile)) { throw 'Initialize signing first with -Action Init.' }
if (!$WslEnvironment) { throw 'Pass -WslEnvironment with the absolute Linux path to your local Android build environment script.' }
if ($Targets | Where-Object { $_ -notin @('aarch64', 'x86_64', 'armv7', 'i686') }) { throw 'Unsupported target.' }
if ($WslEnvironment -notmatch '^/[a-zA-Z0-9_./-]+$') { throw 'Use a Linux environment script path without shell metacharacters.' }
$secure = (Get-Content -LiteralPath $secretFile -Raw).Trim() | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$previousWslEnv = $env:WSLENV
$linuxSigning = $null
try {
    $env:MAVYN_KEYSTORE_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $env:MAVYN_KEY_PASSWORD = $env:MAVYN_KEYSTORE_PASSWORD
    $env:MAVYN_KEY_ALIAS = 'mavyn-release'
    # A restricted Windows directory may be hidden from DrvFS. Keep the source ACL intact.
    $linuxSigning = (& wsl.exe -d Ubuntu --exec mktemp -d /tmp/mavyn-signing.XXXXXX).Trim()
    if ($LASTEXITCODE -ne 0 -or $linuxSigning -notmatch '^/tmp/mavyn-signing\.[a-zA-Z0-9]+$') { throw 'Could not create private WSL signing directory.' }
    [Convert]::ToBase64String([IO.File]::ReadAllBytes($keyFile)) | & wsl.exe -d Ubuntu --exec bash -c 'umask 077; base64 -d > "$1/release.p12"' -- $linuxSigning
    if ($LASTEXITCODE -ne 0) { throw 'Could not copy encrypted signing keystore to WSL.' }
    $env:MAVYN_KEYSTORE = "$linuxSigning/release.p12"
    if ($VersionCode -gt 0) { $env:MAVYN_ANDROID_VERSION_CODE = [string]$VersionCode }
    $env:WSLENV = "$previousWslEnv`:MAVYN_KEYSTORE:MAVYN_KEYSTORE_PASSWORD:MAVYN_KEY_PASSWORD:MAVYN_KEY_ALIAS:MAVYN_ANDROID_VERSION_CODE"
    $repo = (Resolve-Path "$PSScriptRoot/..").Path
    $linuxRepo = (& wsl.exe -d Ubuntu --exec wslpath -a $repo).Trim()
    if ($linuxRepo -notmatch '^/[a-zA-Z0-9_./-]+$') { throw 'Use a repository path without shell metacharacters.' }
    # The frontend must be built first on Windows; the local environment owns SDK/cache paths.
    $command = "source $WslEnvironment; cd $linuxRepo/apps/desktop; npm run tauri -- android build --apk --split-per-abi --target $($Targets -join ' ') --ci --config '{`"build`":{`"beforeBuildCommand`":`"`"}}'"
    & wsl.exe -d Ubuntu --exec bash -c $command
    if ($LASTEXITCODE -ne 0) { throw 'Android release build failed.' }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    foreach ($name in @('MAVYN_KEYSTORE_PASSWORD', 'MAVYN_KEY_PASSWORD', 'MAVYN_KEY_ALIAS', 'MAVYN_KEYSTORE', 'MAVYN_ANDROID_VERSION_CODE')) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    $env:WSLENV = $previousWslEnv
    if ($linuxSigning -match '^/tmp/mavyn-signing\.[a-zA-Z0-9]+$') {
        & wsl.exe -d Ubuntu --exec rm -f -- "$linuxSigning/release.p12"
        & wsl.exe -d Ubuntu --exec rmdir -- $linuxSigning
    }
}
