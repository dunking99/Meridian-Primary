# Restore files from an auto-update backup — for when an update turns out to
# be broken and you want the previous version back immediately, without
# waiting on anything.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\restore-backup.ps1
#     Lists available backups (newest first) and lets you pick one.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\restore-backup.ps1 -Timestamp 20260826-153000
#     Restores that specific backup directly.
#
# This only restores files — it does not touch meridian.db (your holdings and
# price history), which auto-update never touches either.

param([string]$Timestamp)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Get-Item $PSScriptRoot).Parent.Parent.FullName
$ArchiveRoot = Join-Path $RepoRoot '_archive'

if (-not (Test-Path $ArchiveRoot)) {
    Write-Host "No backups found — _archive doesn't exist yet. Nothing has auto-updated on this machine."
    exit 0
}

if (-not $Timestamp) {
    $backups = Get-ChildItem $ArchiveRoot -Directory | Sort-Object Name -Descending
    if (-not $backups) {
        Write-Host "No backups found in _archive."
        exit 0
    }
    Write-Host "Available backups (newest first):"
    $i = 0
    foreach ($b in $backups) {
        $fileCount = (Get-ChildItem $b.FullName -Recurse -File).Count
        Write-Host ("  [{0}] {1}  ({2} file(s))" -f $i, $b.Name, $fileCount)
        $i++
    }
    $choice = Read-Host "`nEnter a number to restore, or press Enter to cancel"
    if (-not $choice) { Write-Host "Cancelled."; exit 0 }
    $Timestamp = $backups[[int]$choice].Name
}

$src = Join-Path $ArchiveRoot $Timestamp
if (-not (Test-Path $src)) {
    Write-Host "No backup found at _archive\$Timestamp"
    exit 1
}

Write-Host "Restoring files from _archive\$Timestamp back into the repo..."
$files = Get-ChildItem $src -Recurse -File
foreach ($f in $files) {
    $rel = $f.FullName.Substring($src.Length + 1)
    $dst = Join-Path $RepoRoot $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item $f.FullName $dst -Force
    Write-Host "  restored $rel"
}

Write-Host "`nDone — $($files.Count) file(s) restored."
Write-Host "Note: this repo is now ahead of what git thinks is checked out. If auto-update"
Write-Host "runs again it will re-pull the newer version unless you also pause it first:"
Write-Host "  scripts\windows\stop-auto-update.ps1"
Write-Host "`nRestart Meridian to pick up the restored files (close the app windows, then"
Write-Host "run: npm start)"
