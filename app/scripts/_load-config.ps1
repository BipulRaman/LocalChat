# Loads config.ps1 from this folder. Dot-sourced by the other scripts.
$ErrorActionPreference = "Stop"

$cfgPath = Join-Path $PSScriptRoot "config.ps1"
if (-not (Test-Path $cfgPath)) {
    Write-Error "config.ps1 not found. Copy config.sample.ps1 to config.ps1 and fill in your values."
    exit 1
}
. $cfgPath

foreach ($name in "Domain","Email","CloudflareApiToken","TlsDir","LocalChatExe") {
    if (-not (Get-Variable -Name $name -ValueOnly -ErrorAction SilentlyContinue)) {
        Write-Error "config.ps1 is missing `$$name"
        exit 1
    }
}

New-Item -ItemType Directory -Path $TlsDir -Force | Out-Null
