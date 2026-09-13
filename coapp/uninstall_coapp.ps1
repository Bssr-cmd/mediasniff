# MediaSniff Companion App Uninstaller
$ErrorActionPreference = "SilentlyContinue"
Write-Host ">>> Removing MediaSniff Native Messaging Host Registry Entries..." -ForegroundColor Yellow

$registryPaths = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\net.mediasniff.coapp",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\net.mediasniff.coapp",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\net.mediasniff.coapp",
    "HKCU:\Software\Chromium\NativeMessagingHosts\net.mediasniff.coapp"
)

foreach ($regPath in $registryPaths) {
    if (Test-Path $regPath) {
        Remove-Item -Path $regPath -Force -Recurse
        Write-Host "  -> Removed: $regPath" -ForegroundColor Green
    }
}

Write-Host "`n>>> Uninstallation complete. Native messaging registrations have been removed." -ForegroundColor Cyan
