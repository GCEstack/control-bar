# GCE Don Control Bar - Uninstall Script
# Removes the permanently installed extension

param(
    [string]$Profile = "h6q809pa.default-release"
)

$ErrorActionPreference = "Stop"

$EXTENSION_ID = "gce-don-control-bar@don.local"
$PROFILE_ROOT = Join-Path $env:APPDATA "Floorp\Profiles"
$PROFILE_PATH = Join-Path $PROFILE_ROOT $Profile
$EXTENSION_DATA_DIR = Join-Path $PROFILE_PATH "browser-extension-data"
$EXTENSION_INSTALL_DIR = Join-Path $EXTENSION_DATA_DIR $EXTENSION_ID

Write-Host "Uninstalling GCE Control Bar from profile: $Profile"

if (Test-Path $EXTENSION_INSTALL_DIR) {
    Remove-Item -Path $EXTENSION_INSTALL_DIR -Recurse -Force
    Write-Host "Removed: $EXTENSION_INSTALL_DIR"
    Write-Host ""
    Write-Host "Uninstallation complete."
    Write-Host "Restart Floorp to complete removal."
} else {
    Write-Host "Extension not found in: $EXTENSION_INSTALL_DIR"
}

Write-Host ""
Write-Host "To reinstall: Run install-permanent.ps1"