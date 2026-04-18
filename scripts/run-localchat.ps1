# Stop any running LocalChat and launch a fresh one, detached.

. (Join-Path $PSScriptRoot "_load-config.ps1")

if (-not (Test-Path $LocalChatExe)) {
    Write-Error "LocalChatExe not found: $LocalChatExe`nBuild it with: cargo build --release"
    exit 1
}

Get-Process localchat -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 600

$wd = Split-Path $LocalChatExe -Parent
Start-Process -FilePath $LocalChatExe -WorkingDirectory $wd

Write-Host "LocalChat started: $LocalChatExe" -ForegroundColor Green
