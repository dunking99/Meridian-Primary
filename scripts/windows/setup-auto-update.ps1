# One-time setup. Run this once (as your normal user, no admin needed):
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\setup-auto-update.ps1
#
# It registers a Windows Scheduled Task that runs auto-update.ps1 every 5
# minutes: check GitHub, and if there's something new, back it up, pull it,
# and restart the app. Also runs once at login, so a restart picks up whatever
# was missed while the machine was off.
#
# Safe to run again later -- it just replaces the existing task definition.

$ErrorActionPreference = 'Stop'
$RepoRoot = (Get-Item $PSScriptRoot).Parent.Parent.FullName
$ScriptPath = Join-Path $PSScriptRoot 'auto-update.ps1'
$TaskName = 'MeridianAutoUpdate'

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NoLogo -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""

$Triggers = @(
    New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 5) `
        -RepetitionDuration (New-TimeSpan -Days 3650)
    New-ScheduledTaskTrigger -AtLogOn
)

$Settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers `
    -Settings $Settings -Description `
    "Checks the Meridian GitHub repo every 5 minutes; backs up and applies updates automatically." `
    -Force | Out-Null

Write-Host ""
Write-Host "Done. '$TaskName' is registered and will check for updates every 5 minutes,"
Write-Host "plus once at every login."
Write-Host ""
Write-Host "It will start Meridian itself if it isn't already running, so you no longer"
Write-Host "need to run 'npm start' by hand."
Write-Host ""
Write-Host "Log:      $RepoRoot\auto-update.log"
Write-Host "Backups:  $RepoRoot\_archive\<timestamp>\  (one folder per update)"
Write-Host ""
Write-Host "To run one check right now instead of waiting: Start-ScheduledTask -TaskName $TaskName"
Write-Host "To stop all of this: scripts\windows\stop-auto-update.ps1"
