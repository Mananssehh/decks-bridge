# Production Windows release build — NSIS + portable + signed updater artifacts
param(
    [switch]$SkipSign
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$conf = Get-Content "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$Version = $conf.version

Write-Host "==> Decks Bridge PRODUCTION Windows build v$Version"

Write-Host "==> [1/4] Build frontend"
npm run build

Write-Host "==> [2/4] Build Tauri (NSIS)"
npx tauri build --bundles nsis

Write-Host "==> [3/4] Optional Authenticode signing"
$Setup = Get-ChildItem "$Root/src-tauri/target/release/bundle/nsis/*.exe" | Select-Object -First 1
$Portable = "$Root/src-tauri/target/release/decks-bridge.exe"

if (-not $SkipSign -and $env:WINDOWS_SIGNING_CERT -and $Setup) {
    $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($signtool) {
        & signtool.exe sign /fd SHA256 /f $env:WINDOWS_SIGNING_CERT /p $env:WINDOWS_SIGNING_CERT_PASSWORD /tr http://timestamp.digicert.com /td SHA256 $Setup.FullName
        & signtool.exe sign /fd SHA256 /f $env:WINDOWS_SIGNING_CERT /p $env:WINDOWS_SIGNING_CERT_PASSWORD /tr http://timestamp.digicert.com /td SHA256 $Portable
        Write-Host "Signed installer and portable exe"
    } else {
        Write-Warning "signtool.exe not found — skipping Authenticode signing"
    }
} else {
    Write-Host "Skipping Authenticode signing (set WINDOWS_SIGNING_CERT for production)"
}

Write-Host "==> [4/4] Package + sign updater archive"
& "$Root/scripts/package-windows-artifacts.ps1" -Version $Version -SignUpdater

Write-Host "==> Production Windows build complete: $Root/release/windows"
