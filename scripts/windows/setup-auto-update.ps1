# One-time setup. Run this once (as your normal user, no admin needed):
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\setup-auto-update.ps1
#
# Registers two Windows Scheduled Tasks:
#
#   MeridianAutoUpdate  -- every 5 minutes: check GitHub, and if there's
#                          something new, back it up, pull it, reinstall if
#                          needed, and restart the app. Does nothing else if
#                          there's nothing new -- it does not relaunch the
#                          app just because it isn't running.
#   MeridianStartOnLogin -- once at login: same check, but also starts the
#                          app if it isn't already running. This is the only
#                          place that happens, so closing Meridian keeps it
#                          closed until you next log in or open it yourself.
#
# Both run invisibly via wscript.exe + run-hidden.vbs. PowerShell's own
# -WindowStyle Hidden does not reliably stop a console window flashing
# briefly when launched by Task Scheduler -- wscript.exe never allocates a
# console at all, so there is nothing to flash.
#
# Safe to run again later -- it just replaces the existing task definitions.

$ErrorActionPreference = 'Stop'
$RepoRoot = (Get-Item $PSScriptRoot).Parent.Parent.FullName
$ScriptPath = Join-Path $PSScriptRoot 'auto-update.ps1'
$VbsPath = Join-Path $PSScriptRoot 'run-hidden.vbs'

$BaseInnerArgs = "-NoProfile -NoLogo -ExecutionPolicy Bypass -File $ScriptPath"

function New-HiddenAction($innerArgs) {
    $wscriptArgs = "`"$VbsPath`" `"powershell.exe`" `"$innerArgs`""
    return New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $wscriptArgs -WorkingDirectory $RepoRoot
}

$Settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew

# Update check -- no -EnsureRunning. Only ever restarts the app when it
# actually pulled a real change; leaves a closed app closed.
$UpdateAction = New-HiddenAction $BaseInnerArgs
$UpdateTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

Register-ScheduledTask -TaskName 'MeridianAutoUpdate' -Action $UpdateAction `
    -Trigger $UpdateTrigger -Settings $Settings -Description `
    "Checks the Meridian GitHub repo every 5 minutes and applies updates automatically. Never starts the app on its own -- only restarts it when there is a real update to apply." `
    -Force | Out-Null

# Login check -- -EnsureRunning, so the app actually comes up after a
# restart or a fresh boot without you having to run npm start by hand.
$LoginAction = New-HiddenAction "$BaseInnerArgs -EnsureRunning"
$LoginTrigger = New-ScheduledTaskTrigger -AtLogOn

Register-ScheduledTask -TaskName 'MeridianStartOnLogin' -Action $LoginAction `
    -Trigger $LoginTrigger -Settings $Settings -Description `
    "Checks for a Meridian update and starts the app at login, if it isn't already running." `
    -Force | Out-Null

Write-Host ""
Write-Host "Done. Two scheduled tasks are registered:"
Write-Host "  MeridianAutoUpdate   -- checks for updates every 5 minutes"
Write-Host "  MeridianStartOnLogin -- checks for updates and starts the app once, at login"
Write-Host ""
Write-Host "Closing Meridian yourself keeps it closed -- only the login check will restart it,"
Write-Host "not the routine 5-minute one."
Write-Host ""
Write-Host "Log:      $RepoRoot\auto-update.log"
Write-Host "Backups:  $RepoRoot\_archive\<timestamp>\  (one folder per update)"
Write-Host ""
Write-Host "To run one update check right now instead of waiting: Start-ScheduledTask -TaskName MeridianAutoUpdate"
Write-Host "To stop all of this: scripts\windows\stop-auto-update.ps1"
