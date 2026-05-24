# MediaSniff Companion App Installer
# This script registers the Native Messaging Host registry keys and dynamically configures the manifest paths and Chrome Extension ID.

$ErrorActionPreference = "Stop"

Write-Host "📡 MediaSniff Companion App Installer Starting..." -ForegroundColor Cyan

# 1. Resolve paths
$coappDir = $PSScriptRoot
$extensionPath = (Get-Item "$coappDir\..").FullName
$manifestPath = "$coappDir\net.mediasniff.coapp.json"
$batPath = "$coappDir\coapp.bat"

Write-Host "  -> Companion directory: $coappDir" -ForegroundColor Gray
Write-Host "  -> Extension directory: $extensionPath" -ForegroundColor Gray

# 2. Mathematically compute the unpacked Extension ID
# Chrome unpacked IDs are calculated as the first 32 characters of the SHA-256 hash
# of the absolute path of the extension directory, mapped to characters a-p (0->a, 15->p).
# Note: Chrome uses standard Windows capitalization (e.g. C:\...) for path hashing.
Write-Host "Calculating Extension ID..." -ForegroundColor Yellow
$cleanPath = $extensionPath.Replace("/", "\")
$pathBytes = [System.Text.Encoding]::UTF8.GetBytes($cleanPath)
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = $sha.ComputeHash($pathBytes)
$sha.Dispose()
$hex = ($hash | ForEach-Object { $_.ToString("x2") }) -join ""
$first32 = $hex.Substring(0, 32)

$calculatedId = ""
for ($i = 0; $i -lt 32; $i++) {
    $c = $first32[$i]
    $val = [Convert]::ToInt32($c, 16)
    $calculatedId += [char]($val + 97)
}

Write-Host "  -> Calculated Extension ID: $calculatedId" -ForegroundColor Green

# 3. Double-check in Chrome User Data Preferences for loaded profiles (if present)
$chromePrefId = $null
$chromePrefPath = "$env:LOCALAPPDATA\Google\Chrome\User Data\**\Preferences"
try {
    $prefFiles = Get-ChildItem -Path "$env:LOCALAPPDATA\Google\Chrome\User Data\" -Filter "Preferences" -Recurse -ErrorAction SilentlyContinue
    foreach ($file in $prefFiles) {
        $content = Get-Content -Raw -Path $file.FullName -ErrorAction SilentlyContinue
        if ($content -and $content.Contains("MediaSniff")) {
            $json = ConvertFrom-Json $content -ErrorAction SilentlyContinue
            if ($json -and $json.extensions -and $json.extensions.settings) {
                foreach ($prop in $json.extensions.settings.psobject.properties) {
                    $extId = $prop.Name
                    $extData = $prop.Value
                    if ($extData -and $extData.manifest -and $extData.manifest.name -and $extData.manifest.name.Contains("MediaSniff")) {
                        $chromePrefId = $extId
                        Write-Host "  -> Found active loaded Extension ID in Chrome Profile: $chromePrefId" -ForegroundColor Green
                        break
                    }
                }
            }
        }
        if ($chromePrefId) { break }
    }
} catch {
    # Ignore folder permission errors
}

# Decide final Extension ID
$finalId = $calculatedId
if ($chromePrefId) {
    $finalId = $chromePrefId
}

# 4. Write/Update net.mediasniff.coapp.json manifest
Write-Host "Writing Native Messaging Manifest..." -ForegroundColor Yellow

# Dynamically generate coapp.bat
try {
    $batContent = "@echo off`npython -u `"%~dp0coapp.py`" %*"
    Set-Content -Path $batPath -Value $batContent -Encoding utf8
    Write-Host "Successfully generated coapp.bat" -ForegroundColor Green
} catch {
    Write-Host "  -> WARNING: Failed to dynamically write coapp.bat" -ForegroundColor Red
}

$allowedOrigins = @(
    "chrome-extension://ijdmgejobfngcmnkckepcnoghjideefc/",
    "chrome-extension://negfehinkcmfkllilefjdfglifjhehco/",
    "chrome-extension://dmjcpajgemdhaglcngpokhdmfepgbffm/",
    "chrome-extension://njflocbkdhocjoabjafodemcphglfmog/"
)

$manifestData = @{
    name = "net.mediasniff.coapp"
    description = "MediaSniff Companion App for native video downloading and remuxing"
    path = $batPath
    type = "stdio"
    allowed_origins = $allowedOrigins
}

$manifestJson = ConvertTo-Json $manifestData -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $manifestJson)
Write-Host "  -> Manifest written successfully to: $manifestPath" -ForegroundColor Green

# 5. Create Registry Keys under HKCU
Write-Host "Writing Windows Registry keys..." -ForegroundColor Yellow
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\net.mediasniff.coapp"

if (!(Test-Path $registryPath)) {
    New-Item -Path $registryPath -Force | Out-Null
}
Set-ItemProperty -Path $registryPath -Name '' -Value $manifestPath -Force
Write-Host "  -> Registry entry created under HKCU: net.mediasniff.coapp" -ForegroundColor Green

# 6. Verify FFmpeg
Write-Host "Checking for FFmpeg dependency..." -ForegroundColor Yellow
$ffmpegInPath = $false
try {
    $null = Get-Command "ffmpeg" -ErrorAction SilentlyContinue
    $ffmpegInPath = $true
    Write-Host "  -> FFmpeg is already installed and available in the system PATH." -ForegroundColor Green
} catch {}

if (!$ffmpegInPath) {
    $localFfmpeg = Join-Path $coappDir "ffmpeg.exe"
    if (Test-Path $localFfmpeg) {
        Write-Host "  -> Standalone ffmpeg.exe is present in the companion folder." -ForegroundColor Green
    } else {
        Write-Host "  -> WARNING: FFmpeg was not found on your system!" -ForegroundColor Red
        Write-Host "     Lossless stream merging requires FFmpeg." -ForegroundColor Red
        Write-Host "     Please copy 'ffmpeg.exe' into the companion folder: $coappDir" -ForegroundColor Yellow
        Write-Host "     or install it in your system environment PATH." -ForegroundColor Yellow
    }
}

# 7. Check and install yt-dlp Python package dependency
Write-Host "Checking and installing yt-dlp Python package dependency..." -ForegroundColor Yellow
try {
    Start-Process python -ArgumentList "-m pip install yt-dlp" -Wait -NoNewWindow
    Write-Host "  -> yt-dlp package check and installation completed successfully!" -ForegroundColor Green
} catch {
    Write-Host "  -> WARNING: Failed to automatically run pip install yt-dlp. Please run it manually." -ForegroundColor Red
}

Write-Host "📡 MediaSniff Companion App installed successfully!" -ForegroundColor Green
Write-Host "Please reload the unpacked MediaSniff extension in Chrome (chrome://extensions) to activate changes." -ForegroundColor Cyan
