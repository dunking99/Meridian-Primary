' Runs one command completely invisibly -- no window, ever, not even a brief
' flash. PowerShell's own -WindowStyle Hidden does not reliably prevent a
' console window from flashing when launched by Task Scheduler or
' Start-Process, because powershell.exe and cmd.exe both briefly allocate a
' console before that window style can take effect. wscript.exe never
' allocates a console at all, so shelling out through it side-steps the
' problem entirely rather than trying to hide it after the fact.
'
' Usage: wscript.exe run-hidden.vbs "<executable>" "<arguments>"
' The working directory is inherited from however wscript.exe itself was
' launched -- set it on the caller (Start-Process -WorkingDirectory, or
' New-ScheduledTaskAction -WorkingDirectory), not here.

Dim objArgs, objShell, cmd
Set objArgs = WScript.Arguments
Set objShell = CreateObject("WScript.Shell")
cmd = """" & objArgs(0) & """ " & objArgs(1)
objShell.Run cmd, 0, False
