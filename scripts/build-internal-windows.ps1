# Internal/private Windows beta build — unsigned NSIS + portable exe
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$conf = Get-Content "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$Version = $conf.version

Write-Host "==> Decks Bridge INTERNAL Windows build v$Version"

Write-Host "==> [1/4] Build frontend"
npm run build

Write-Host "==> [2/4] Build Tauri (NSIS + portable exe)"
npx tauri build --bundles nsis

Write-Host "==> [3/4] Package artifacts"
& "$Root/scripts/package-windows-artifacts.ps1" -Version $Version

Write-Host "==> [4/4] Verify portable exe exists"
$Portable = Join-Path $Root "release/windows/Decks Bridge Portable.exe"
if (-not (Test-Path $Portable)) {
    throw "Portable executable missing after packaging"
}

Write-Host ""
Write-Host "==> Internal Windows build complete"
Write-Host "Send testers this folder:"
Write-Host "  $Root/windows"
Write-Host ""
Write-Host "Contents:"
Get-ChildItem (Join-Path $Root "windows") | ForEach-Object { Write-Host "  $($_.Name)" }
