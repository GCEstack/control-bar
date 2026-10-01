# GCE Don Control Bar - Permanent Installation Script
# Run as Administrator or from Floorp profile context
# This script installs the Control Bar extension permanently

param(
    [string]$Profile = "h6q809pa.default-release",
    [string]$Version = "1.2.0"
)

$ErrorActionPreference = "Stop"

$EXTENSION_ID = "gce-don-control-bar@don.local"
$PACKAGE_PATH = Join-Path $PSScriptRoot "gce-don-control-bar-$Version.xpi"

# Find Floorp profile directory
$PROFILE_ROOT = Join-Path $env:APPDATA "Floorp\Profiles"
$PROFILE_PATH = Join-Path $PROFILE_ROOT $Profile

if (-not (Test-Path $PROFILE_PATH)) {
    Write-Error "Profile not found: $Profile"
    exit 1
}

$EXTENSION_DATA_DIR = Join-Path $PROFILE_PATH "browser-extension-data"
$EXTENSION_INSTALL_DIR = Join-Path $EXTENSION_DATA_DIR $EXTENSION_ID

Write-Host "Installing GCE Control Bar v$Version to profile: $Profile"

# Ensure directory exists
if (-not (Test-Path $EXTENSION_DATA_DIR)) {
    New-Item -ItemType Directory -Path $EXTENSION_DATA_DIR -Force | Out-Null
}

if (-not (Test-Path $EXTENSION_INSTALL_DIR)) {
    New-Item -ItemType Directory -Path $EXTENSION_INSTALL_DIR -Force | Out-Null
}

# Copy extension files
if (Test-Path $PACKAGE_PATH) {
    # It's a packaged extension - extract to extension directory
    # PowerShell Expand-Archive rejects .xpi even though it's ZIP format
    # Workaround: copy to temp .zip, extract, then remove temp file
    $tempZip = [System.IO.Path]::Combine($env:TEMP, "gce-temp-install-$([System.Guid]::NewGuid().ToString('N')).zip")
    try {
        Copy-Item -Path $PACKAGE_PATH -Destination $tempZip -Force
        Expand-Archive -Path $tempZip -DestinationPath $EXTENSION_INSTALL_DIR -Force
        Write-Host "Extracted extension package"
    } finally {
        if (Test-Path $tempZip) { Remove-Item -Path $tempZip -Force }
    }
} else {
    # Source directory - copy directly
    $SOURCE_PATH = Join-Path $PSScriptRoot "extension"
    Copy-Item -Path "$SOURCE_PATH\*" -Destination $EXTENSION_INSTALL_DIR -Recurse -Force
    Write-Host "Copied extension from source"
}

# Create manifest with installation metadata
$INSTALL_MANIFEST = @{
    installedBy = $env:USERNAME
    installedAt = (Get-Date -Format "o")
    version = $Version
    source = $PACKAGE_PATH
} | ConvertTo-Json

Set-Content -Path (Join-Path $EXTENSION_INSTALL_DIR "INSTALL_MANIFEST.json") -Value $INSTALL_MANIFEST

Write-Host ""
Write-Host "Installation complete!"
Write-Host "Extension ID: $EXTENSION_ID"
Write-Host "Install directory: $EXTENSION_INSTALL_DIR"
Write-Host ""
Write-Host "IMPORTANT: You must restart Floorp for the extension to load."
Write-Host "After restart, verify the extension is enabled in about:addons"

# Verify installation
Write-Host ""
Write-Host "Verifying installation..."
$manifestPath = Join-Path $EXTENSION_INSTALL_DIR "manifest.json"
if (Test-Path $manifestPath) {
    $manifest = Get-Content $manifestPath | ConvertFrom-Json
    Write-Host "VERIFIED: Extension $($manifest.name) v$($manifest.version)"
    
    # Check key files exist
    $requiredFiles = @("manifest.json", "background/main.js", "sidebar/panel.html", "content/chatgpt-observer.js")
    $missingFiles = @()
    foreach ($f in $requiredFiles) {
        $fullPath = Join-Path $EXTENSION_INSTALL_DIR $f
        if (-not (Test-Path $fullPath)) {
            $missingFiles += $f
        }
    }
    if ($missingFiles.Count -gt 0) {
        Write-Warning "Warning: Missing files: $($missingFiles -join ', ')"
    } else {
        Write-Host "VERIFIED: All core files present"
    }
} else {
    Write-Error "FAILED: manifest.json not found in installation directory - installation may have failed"
    exit 1
}

Write-Host ""
Write-Host "To upgrade: Run this script again with the new version"
Write-Host "To rollback: Use git checkout to restore files, then run this script"