# Removes the scheduled task set up by setup-auto-update.ps1. Does not stop
# Meridian itself if it's currently running — just stops future automatic
# updates and restarts.

$TaskName = 'MeridianAutoUpdate'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "'$TaskName' removed. Meridian will no longer auto-update."
} else {
    Write-Host "No '$TaskName' task found — nothing to remove."
}
