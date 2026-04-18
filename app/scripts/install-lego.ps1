# Installs lego (the ACME client) via winget.
# Safe to run multiple times — winget will skip if already installed.

$ErrorActionPreference = "Stop"

Write-Host "Installing lego via winget..." -ForegroundColor Cyan
winget install --id goacme.lego --accept-source-agreements --accept-package-agreements

# winget updates PATH at the user level; this session needs a refresh.
$machinePath = [Environment]::GetEnvironmentVariable("Path","Machine")
$userPath    = [Environment]::GetEnvironmentVariable("Path","User")
$env:PATH = "$machinePath;$userPath"

try {
    $v = & lego --version 2>&1 | Select-Object -First 1
    Write-Host "lego installed: $v" -ForegroundColor Green
} catch {
    Write-Warning "lego is installed but not on PATH in this session. Open a new PowerShell window."
}
