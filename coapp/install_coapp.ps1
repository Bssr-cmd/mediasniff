# MediaSniff Companion App Installer
# This script registers the Native Messaging Host registry keys and dynamically configures the manifest paths and Chrome Extension ID.
$ErrorActionPreference = "Stop"
Write-Host ">>> MediaSniff Companion App Installer Starting..." -ForegroundColor Cyan

# 1. Resolve paths
$coappDir = $PSScriptRoot
if (!$coappDir) {
    $coappDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if (!$coappDir) {
    $coappDir = (Get-Item "coapp").FullName
}
$extensionPath = (Get-Item "$coappDir\..").FullName
$manifestPath = "$coappDir\net.mediasniff.coapp.json"
$batPath = "$coappDir\coapp.bat"
Write-Host "  -> Companion directory: $coappDir" -ForegroundColor Gray
Write-Host "  -> Extension directory: $extensionPath" -ForegroundColor Gray

# 1b. Resolve Python executable (bundled portable, system, or auto-download)
Write-Host "Resolving Python executable..." -ForegroundColor Yellow
$bundledPython = Join-Path $coappDir "python\python.exe"
$pythonExe = $null
$isBundled = $false

if (Test-Path $bundledPython) {
    $pythonExe = $bundledPython
    $isBundled = $true
    Write-Host "  -> Found bundled portable Python: $pythonExe" -ForegroundColor Green
} else {
    try {
        $realPython = (python -c "import sys; print(sys.executable)").Trim()
        if ($realPython -and (Test-Path $realPython) -and !($realPython -match "WindowsApps")) {
            $pythonExe = $realPython
            Write-Host "  -> Found system Python: $pythonExe" -ForegroundColor Green
        }
    } catch {}
}

if (!$pythonExe) {
    Write-Host "  -> Python not detected on system. Auto-downloading portable Python 3.12..." -ForegroundColor Cyan
    $pyZipUrl = "https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip"
    $pyZipDest = Join-Path $coappDir "python_embed.zip"
    $pyDir = Join-Path $coappDir "python"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Host "  -> Fetching $pyZipUrl..." -ForegroundColor Gray
        Invoke-WebRequest -Uri $pyZipUrl -OutFile $pyZipDest -UseBasicParsing
        Expand-Archive -Path $pyZipDest -DestinationPath $pyDir -Force
        Remove-Item $pyZipDest -Force -ErrorAction SilentlyContinue
        if (Test-Path $bundledPython) {
            $pythonExe = $bundledPython
            $isBundled = $true
            Write-Host "  -> Portable Python installed successfully to: $pyDir" -ForegroundColor Green
        }
    } catch {
        Write-Host "  -> Failed to auto-download Python: $_" -ForegroundColor Red
        throw "Python is required but was not found and could not be downloaded."
    }
}

# Write coapp.bat
Write-Host "Configuring coapp.bat..." -ForegroundColor Yellow
if ($isBundled) {
    $batContent = "@echo off`r`n`"%~dp0python\python.exe`" -u `"%~dp0coapp.py`" %*`r`n"
} else {
    $batContent = "@echo off`r`n`"$pythonExe`" -u `"%~dp0coapp.py`" %*`r`n"
}
[System.IO.File]::WriteAllText($batPath, $batContent)
Write-Host "  -> coapp.bat written successfully." -ForegroundColor Green

# 2. Mathematically compute unpacked Extension IDs
Write-Host "Calculating Extension ID variations..." -ForegroundColor Yellow
function Get-ExtensionId([string]$path) {
    $clean = $path.Replace("/", "\")
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($clean)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash($bytes)
    $sha.Dispose()
    $hex = ($hash | ForEach-Object { $_.ToString("x2") }) -join ""
    $first32 = $hex.Substring(0, 32)
    $id = ""
    for ($i = 0; $i -lt 32; $i++) {
        $c = $first32[$i]
        $val = [Convert]::ToInt32($c, 16)
        $id += [char]($val + 97)
    }
    return $id
}

$drive = $extensionPath.Substring(0, 2)
$rest = $extensionPath.Substring(2)
$pathVariations = @(
    $extensionPath,
    ($drive.ToLower() + $rest),
    ($drive.ToUpper() + $rest),
    ($extensionPath.Replace("\", "/")),
    (($drive.ToLower() + $rest).Replace("\", "/")),
    (($drive.ToUpper() + $rest).Replace("\", "/"))
)

$uniqueIds = [System.Collections.Generic.HashSet[string]]::new()
foreach ($pv in $pathVariations) {
    $eid = Get-ExtensionId $pv
    $null = $uniqueIds.Add($eid)
    Write-Host "  -> Calculated ID ($pv): $eid" -ForegroundColor Gray
}

# 3. Double-check in Chrome/Edge/Brave User Data Preferences for loaded profiles
$chromePrefPath = @(
    "$env:LOCALAPPDATA\Google\Chrome\User Data",
    "$env:LOCALAPPDATA\Microsoft\Edge\User Data",
    "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data",
    "$env:LOCALAPPDATA\Chromium\User Data"
)
try {
    foreach ($path in $chromePrefPath) {
        if (Test-Path $path) {
            $prefFiles = Get-ChildItem -Path $path -Filter "Preferences" -Recurse -ErrorAction SilentlyContinue
            foreach ($file in $prefFiles) {
                $content = Get-Content -Raw -Path $file.FullName -ErrorAction SilentlyContinue
                if ($content -and ($content.Contains("MediaSniff") -or $content.Contains("mediasniff"))) {
                    $json = ConvertFrom-Json $content -ErrorAction SilentlyContinue
                    if ($json -and $json.extensions -and $json.extensions.settings) {
                        foreach ($prop in $json.extensions.settings.psobject.properties) {
                            $extData = $prop.Value
                            if ($extData -and $extData.manifest -and $extData.manifest.name -and ($extData.manifest.name -match "(?i)mediasniff")) {
                                $null = $uniqueIds.Add($prop.Name)
                                Write-Host "  -> Found active loaded Extension ID in profile: $($prop.Name)" -ForegroundColor Green
                            }
                        }
                    }
                }
            }
        }
    }
} catch {}

# 4. Write/Update net.mediasniff.coapp.json manifest
Write-Host "Writing Native Messaging Manifest..." -ForegroundColor Yellow
$allowedOrigins = @()
foreach ($id in $uniqueIds) {
    $allowedOrigins += "chrome-extension://$id/"
}

$manifestData = [ordered]@{
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
$registryPaths = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\net.mediasniff.coapp",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\net.mediasniff.coapp",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\net.mediasniff.coapp",
    "HKCU:\Software\Chromium\NativeMessagingHosts\net.mediasniff.coapp"
)
foreach ($regPath in $registryPaths) {
    if (!(Test-Path $regPath)) {
        New-Item -Path $regPath -Force | Out-Null
    }
    Set-ItemProperty -Path $regPath -Name '(default)' -Value $manifestPath -Force
    Write-Host "  -> Registry entry created under: $regPath" -ForegroundColor Green
}

# 6. Verify FFmpeg & yt-dlp
Write-Host "Checking companion binaries..." -ForegroundColor Yellow
$localFfmpeg = Join-Path $coappDir "ffmpeg.exe"
if (Test-Path $localFfmpeg) {
    Write-Host "  -> ffmpeg.exe found in companion folder." -ForegroundColor Green
} else {
    Write-Host "  -> WARNING: ffmpeg.exe missing in companion folder!" -ForegroundColor Yellow
}

$localYtdlp = Join-Path $coappDir "yt-dlp.exe"
if (Test-Path $localYtdlp) {
    Write-Host "  -> yt-dlp.exe found in companion folder." -ForegroundColor Green
} else {
    Write-Host "  -> WARNING: yt-dlp.exe missing in companion folder!" -ForegroundColor Yellow
}

Write-Host ">>> MediaSniff Companion App installed successfully!" -ForegroundColor Green
Write-Host "Please reload the MediaSniff extension in Chrome to activate changes." -ForegroundColor Cyan
