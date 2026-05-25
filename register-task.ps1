# ============================================================
#  Samta — One-Time Task Scheduler Setup
#  Run this ONCE as Administrator to enable auto git sync.
# ============================================================

$TASK_NAME  = "SamtaGitSync"
$SCRIPT_SRC = "$PSScriptRoot\git-sync-samta.ps1"
$SCRIPT_DEST = "C:\Users\anish\dev\whatsapp-religious-friend-main\git-sync-samta.ps1"

# ── Copy the sync script into the project folder ─────────────
Copy-Item -Path $SCRIPT_SRC -Destination $SCRIPT_DEST -Force
Write-Host "Sync script copied to project folder." -ForegroundColor Green

# ── Remove old task if it exists ─────────────────────────────
if (Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
    Write-Host "Removed existing task." -ForegroundColor Yellow
}

# ── Build the scheduled task ─────────────────────────────────
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$SCRIPT_DEST`""

# Trigger: at logon for THIS user
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Run as current user, highest privileges, hidden
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable `
    -DontStopOnIdleEnd

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TASK_NAME `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Auto git pull for Samta project at logon" `
    | Out-Null

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Task '$TASK_NAME' registered!" -ForegroundColor Green
Write-Host "  Runs automatically at every logon." -ForegroundColor Green
Write-Host ""
Write-Host "  Sync log: C:\Users\anish\dev\whatsapp-religious-friend-main\.git-sync.log" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "To verify: open Task Scheduler and look for '$TASK_NAME'" -ForegroundColor Gray
Write-Host "To remove: Unregister-ScheduledTask -TaskName '$TASK_NAME'" -ForegroundColor Gray
