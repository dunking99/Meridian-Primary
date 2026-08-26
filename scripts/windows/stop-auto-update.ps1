# Removes both scheduled tasks set up by setup-auto-update.ps1. Does not stop
# Meridian itself if it's currently running -- just stops future automatic
# updates, restarts, and login-time starts.

$TaskNames = 'MeridianAutoUpdate', 'MeridianStartOnLogin'

foreach ($name in $TaskNames) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "'$name' removed."
    } else {
        Write-Host "No '$name' task found -- nothing to remove."
    }
}
Write-Host "`nMeridian will no longer auto-update or auto-start."
