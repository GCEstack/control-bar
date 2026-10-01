# GCE Don Control Bar - Permanent Installation Script
# Run as Administrator or from Floorp profile context
# This script installs the Control Bar extension permanently

param(
    [string]$Profile = "h6q809pa.default-release",
    # Defaults to the CURRENT build. It was pinned at 1.2.0, so running this
    # script with no arguments installed the oldest XPI in the tree while
    # printing a success message. The default now follows manifest.json, and a
    # missing package is a hard error rather than a silent fallback to the
    # source directory.
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$EXTENSION_ID = "gce-don-control-bar@don.local"

# Resolve the version from the built extension when the caller did not name one.
if ([string]::IsNullOrWhiteSpace($Version)) {
    $manifestCandidate = Join-Path $PSScriptRoot "extension\manifest.json"
    if (-not (Test-Path $manifestCandidate)) {
        Write-Error "No version given and extension\manifest.json is missing. Pass -Version explicitly."
        exit 1
    }
    $Version = (Get-Content $manifestCandidate | ConvertFrom-Json).version
}

$PACKAGE_PATH = Join-Path $PSScriptRoot "gce-don-control-bar-$Version.xpi"

if (-not (Test-Path $PACKAGE_PATH)) {
    Write-Error "Package not found: $PACKAGE_PATH"
    Write-Host ""
    Write-Host "Available packages:"
    Get-ChildItem $PSScriptRoot -Filter "gce-don-control-bar-*.xpi" |
        ForEach-Object { Write-Host "  $($_.Name)" }
    exit 1
}

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

# Back up whatever is installed before overwriting it, so a failed install is
# recoverable and the previous version stays inspectable.
if (Test-Path $EXTENSION_INSTALL_DIR) {
    $existingManifest = Join-Path $EXTENSION_INSTALL_DIR "manifest.json"
    $existingVersion = "unknown"
    if (Test-Path $existingManifest) {
        try { $existingVersion = (Get-Content $existingManifest | ConvertFrom-Json).version }
        catch { $existingVersion = "unreadable" }
    }
    if ($existingVersion -ne $Version) {
        $backup = "$EXTENSION_INSTALL_DIR.backup-v$existingVersion"
        if (Test-Path $backup) { Remove-Item -Path $backup -Recurse -Force }
        Copy-Item -Path $EXTENSION_INSTALL_DIR -Destination $backup -Recurse -Force
        Write-Host "Backed up installed v$existingVersion -> $backup"
    } else {
        Write-Host "Installed copy is already v$Version - overwriting in place"
    }
}

# PowerShell Expand-Archive rejects .xpi even though it is ZIP format, so copy
# to a temp .zip, extract, then remove the temp file. No source-directory
# fallback: installing a tree is not the same act as installing a package, and
# silently doing the other one is how a stale build reaches a profile.
$tempZip = [System.IO.Path]::Combine($env:TEMP, "gce-temp-install-$([System.Guid]::NewGuid().ToString('N')).zip")
try {
    Copy-Item -Path $PACKAGE_PATH -Destination $tempZip -Force
    Expand-Archive -Path $tempZip -DestinationPath $EXTENSION_INSTALL_DIR -Force
    Write-Host "Extracted $PACKAGE_PATH"
} finally {
    if (Test-Path $tempZip) { Remove-Item -Path $tempZip -Force }
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
        Write-Error "FAILED: Missing files: $($missingFiles -join ', ')"
        exit 1
    }
    Write-Host "VERIFIED: All core files present"

    # The version on disk must be the version that was requested. A copy that
    # silently landed an older package is the exact failure this script had.
    $installedVersion = $manifest.version
    if ($installedVersion -ne $Version) {
        Write-Error "FAILED: requested v$Version but manifest reports v$installedVersion"
        exit 1
    }
    Write-Host "VERIFIED: on-disk version matches request (v$installedVersion)"
} else {
    Write-Error "FAILED: manifest.json not found in installation directory - installation may have failed"
    exit 1
}

Write-Host ""
Write-Host "To upgrade: Run this script again with the new version"
Write-Host "To rollback: Use git checkout to restore files, then run this script"