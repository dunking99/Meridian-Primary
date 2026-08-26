# Meridian auto-update.
#
# Run on a schedule (see setup-auto-update.ps1). Each run: check GitHub for a
# new commit on main, and if there is one, back up every file about to change,
# pull, reinstall dependencies if package.json moved, and restart the app.
# If there is nothing new, it just makes sure the app is actually running.
#
# Nothing here touches meridian.db -- it is gitignored and untouched by git
# pull regardless.

$ErrorActionPreference = 'Stop'

$RepoRoot = (Get-Item $PSScriptRoot).Parent.Parent.FullName
Set-Location $RepoRoot

$LogFile = Join-Path $RepoRoot 'auto-update.log'
function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogFile -Value $line
    Write-Host $line
}

# Trim the log rather than let it grow forever.
if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 2MB) {
    Get-Content $LogFile -Tail 2000 | Set-Content "$LogFile.tmp"
    Move-Item "$LogFile.tmp" $LogFile -Force
}

function Test-PortOpen($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$conn
}

function Restart-Meridian {
    Log "Restarting Meridian..."
    foreach ($port in 3001, 5173) {
        Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
            ForEach-Object {
                try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop }
                catch { }
            }
    }
    Start-Sleep -Seconds 2
    # npm.cmd, not npm -- Start-Process doesn't go through a shell, and plain
    # "npm" on Windows only resolves via PATHEXT inside a shell.
    Start-Process -FilePath "npm.cmd" -ArgumentList "start" `
        -WorkingDirectory $RepoRoot -WindowStyle Hidden
    Log "Restart issued."
}

try {
    git fetch origin main *>&1 | ForEach-Object { Log "  git: $_" }
}
catch {
    Log "git fetch failed -- no network, or GitHub unreachable. Leaving the app as-is: $_"
    if (-not (Test-PortOpen 5173)) { Restart-Meridian }
    exit 0
}

$localRev  = (git rev-parse HEAD).Trim()
$remoteRev = (git rev-parse origin/main).Trim()

if ($localRev -eq $remoteRev) {
    Log "No update available (up to date at $($localRev.Substring(0,7)))."
    if (-not (Test-PortOpen 5173)) {
        Log "App isn't running -- starting it."
        Restart-Meridian
    }
    exit 0
}

Log "Update available: $($localRev.Substring(0,7)) -> $($remoteRev.Substring(0,7))"

# A tracked file edited by hand locally would make the pull unsafe to do
# silently -- back off rather than overwrite or discard it.
git diff --quiet
if (-not $?) {
    Log "Local edits found in tracked files -- not pulling automatically. Resolve manually (git status), then this will resume next cycle."
    exit 1
}
$untrackedNote = git status --porcelain --untracked-files=no
if ($untrackedNote) {
    Log "Note: local changes present (staged). Proceeding anyway since git pull --ff-only will fail loudly if unsafe."
}

# Back up every file about to change before touching anything, one folder per
# update, mirroring the repo's relative paths so restoring means copying the
# folder's contents back over the repo root.
$changed = git diff --name-only $localRev $remoteRev
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $RepoRoot "_archive\$stamp"

foreach ($f in $changed) {
    $src = Join-Path $RepoRoot $f
    if (Test-Path $src -PathType Leaf) {
        $dst = Join-Path $backupDir $f
        New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
        Copy-Item $src $dst -Force
    }
}
Log "Backed up $($changed.Count) file(s) to _archive\$stamp before updating."

try {
    # --ff-only: this machine never has local commits of its own, so a
    # non-fast-forward here means something unexpected happened. Fail loudly
    # rather than auto-merge.
    git pull --ff-only origin main *>&1 | ForEach-Object { Log "  git: $_" }
}
catch {
    Log "git pull failed: $_. Left at $($localRev.Substring(0,7)). Backup is in _archive\$stamp if needed -- check manually."
    exit 1
}

if ($changed -contains 'package.json' -or $changed -contains 'package-lock.json') {
    Log "package.json changed -- running npm install (this can take a minute)."
    try {
        npm install *>&1 | ForEach-Object { Log "  npm: $_" }
    }
    catch {
        Log "npm install failed: $_. The app may not start correctly until this is resolved."
    }
}

Restart-Meridian
Log "Update complete. Now at $($remoteRev.Substring(0,7))."
