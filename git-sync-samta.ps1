# ============================================================
#  Samta — Auto Git Sync
#  Runs at logon via Task Scheduler. Do not delete.
# ============================================================

$PROJECT_DIR = "C:\Users\anish\dev\whatsapp-religious-friend-main"
$LOG_FILE    = "C:\Users\anish\dev\whatsapp-religious-friend-main\.git-sync.log"

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Add-Content -Path $LOG_FILE -Value $line
}

Set-Location $PROJECT_DIR

$branch = git rev-parse --abbrev-ref HEAD 2>&1
Log "--- sync start (branch: $branch) ---"

# Fetch quietly
git fetch origin 2>&1 | Out-Null

$behind = git rev-list --count HEAD..origin/$branch 2>&1

if ($behind -gt 0) {
    Log "Behind by $behind commit(s) — pulling..."

    # Stash dirty working tree so pull never fails
    $dirty = git status --porcelain
    if ($dirty) {
        git stash push -m "auto-stash $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 2>&1 | Out-Null
        Log "Stashed local changes before pull"
    }

    $result = git pull origin $branch 2>&1
    Log "Pull result: $result"

    if ($dirty) {
        git stash pop 2>&1 | Out-Null
        Log "Re-applied stashed changes"
    }

    # Install deps if package.json changed
    $pkgChanged = git diff HEAD~1 HEAD --name-only 2>$null | Where-Object { $_ -eq "package.json" }
    if ($pkgChanged) {
        Log "package.json changed — running npm install"
        npm install 2>&1 | Out-Null
    }
} else {
    Log "Already up to date"
}

Log "--- sync complete ---"
