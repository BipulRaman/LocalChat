# Registers a weekly scheduled task that runs renew-cert.ps1.
# Re-run to update an existing task.

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "renew-cert.ps1"
$taskName   = "LocalChat-Cert-Renew"

$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
            -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
            -RunLevel Highest -LogonType S4U
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Scheduled task '$taskName' registered (Sundays at 3am)." -ForegroundColor Green
Write-Host "Test it now: Start-ScheduledTask -TaskName $taskName"
