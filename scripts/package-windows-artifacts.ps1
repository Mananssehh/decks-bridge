# Package Windows Tauri build outputs into release/windows/
param(
    [string]$Version = "",
    [string]$TargetDir = "",
    [switch]$SignUpdater
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $Version) {
    $conf = Get-Content "$Root/src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
    $Version = $conf.version
}

if (-not $TargetDir) {
    $TargetDir = "$Root/src-tauri/target/release"
}

$NsisDir = Join-Path $TargetDir "bundle/nsis"
$PortableSrc = Join-Path $TargetDir "decks-bridge.exe"
$WinOut = Join-Path $Root "release/windows"
$VersionOut = Join-Path $Root "release/v$Version/windows"

New-Item -ItemType Directory -Force -Path $WinOut, $VersionOut | Out-Null

if (-not (Test-Path $PortableSrc)) {
    throw "Missing portable executable: $PortableSrc"
}

$SetupExe = Get-ChildItem -Path $NsisDir -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $SetupExe) {
    throw "Missing NSIS installer in $NsisDir"
}

$SetupDest = Join-Path $WinOut "Decks Bridge Setup.exe"
$PortableDest = Join-Path $WinOut "Decks Bridge Portable.exe"
$ZipDest = Join-Path $WinOut "Decks Bridge.zip"

Copy-Item -Force $SetupExe.FullName $SetupDest
Copy-Item -Force $PortableSrc $PortableDest

if (Test-Path $ZipDest) { Remove-Item $ZipDest -Force }
Compress-Archive -Path $PortableDest -DestinationPath $ZipDest -Force

Copy-Item -Force $SetupDest (Join-Path $VersionOut "Decks Bridge_${Version}_x64-setup.exe")
Copy-Item -Force $PortableDest (Join-Path $VersionOut "Decks.Bridge_${Version}_x64-portable.exe")
Copy-Item -Force $ZipDest (Join-Path $VersionOut "Decks.Bridge_${Version}_x64.zip")

# Updater archive (.nsis.zip) for Tauri updater
$UpdaterZip = Join-Path $VersionOut "Decks Bridge_${Version}_x64-setup.nsis.zip"
if (Test-Path $UpdaterZip) { Remove-Item $UpdaterZip -Force }
Compress-Archive -Path $SetupDest -DestinationPath $UpdaterZip -Force
Copy-Item -Force $UpdaterZip (Join-Path $WinOut "Decks Bridge Setup.nsis.zip")

if ($SignUpdater) {
    $envFile = Join-Path $Root ".env.signing"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
                Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim('"')
            }
        }
    }
    if ($env:TAURI_SIGNING_PRIVATE_KEY) {
        Push-Location $Root
        npx tauri signer sign $UpdaterZip
        Pop-Location
        Copy-Item -Force "$UpdaterZip.sig" (Join-Path $WinOut "Decks Bridge Setup.nsis.zip.sig")
        Copy-Item -Force "$UpdaterZip.sig" (Join-Path $VersionOut "Decks Bridge_${Version}_x64-setup.nsis.zip.sig")
        Write-Host "Signed updater archive: $UpdaterZip.sig"
    } else {
        Write-Warning "TAURI_SIGNING_PRIVATE_KEY not set — skipping updater signature"
    }
}

Copy-Item -Force "$Root/TEST_INSTALL_WINDOWS.md" (Join-Path $WinOut "TEST_INSTALL_WINDOWS.md") -ErrorAction SilentlyContinue

# Tester folder — send "windows" to Windows DJs
$TesterDir = Join-Path $Root "windows"
New-Item -ItemType Directory -Force -Path $TesterDir | Out-Null
Copy-Item -Force $SetupDest (Join-Path $TesterDir "Decks Bridge Setup.exe")
Copy-Item -Force $PortableDest (Join-Path $TesterDir "Decks Bridge Portable.exe")
Copy-Item -Force $ZipDest (Join-Path $TesterDir "Decks Bridge.zip")
Copy-Item -Force "$Root/TEST_INSTALL_WINDOWS.md" (Join-Path $TesterDir "TEST_INSTALL.md") -ErrorAction SilentlyContinue
$Readme = Join-Path $TesterDir "README.md"
if (-not (Test-Path $Readme)) {
    Copy-Item -Force (Join-Path $Root "windows/README.md") $Readme -ErrorAction SilentlyContinue
}
Write-Host "Tester folder: $TesterDir"

Write-Host ""
Write-Host "Windows release artifacts:"
Get-ChildItem $WinOut | ForEach-Object { Write-Host "  $($_.FullName)  ($([math]::Round($_.Length/1MB, 2)) MB)" }

Write-Host ""
Write-Host "SHA256:"
Get-FileHash -Algorithm SHA256 $SetupDest, $PortableDest, $ZipDest | Format-Table -AutoSize
