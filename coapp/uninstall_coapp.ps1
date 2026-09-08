# MediaSniff Companion App Uninstaller
$ErrorActionPreference = "SilentlyContinue"
Write-Host "Removing MediaSniff Native Messaging Host Registry Entries..." -ForegroundColor Yellow

$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\net.mediasniff.coapp"
if (Test-Path $regPath) {
    Remove-Item -Path $regPath -Force -Recurse
    Write-Host "  -> Removed Chrome native messaging registration." -ForegroundColor Green
} else {
    Write-Host "  -> Registry entry not found (already clean)." -ForegroundColor Gray
}

Write-Host "`nUninstallation complete. You may safely delete this folder." -ForegroundColor Cyan
