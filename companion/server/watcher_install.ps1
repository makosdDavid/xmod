<#
Installs the X4 Companion watcher for the current user and starts it now.

Creates ONE shortcut in the user's Startup folder ([Environment]::GetFolderPath('Startup')):
    target:     %SystemRoot%\System32\conhost.exe
    arguments:  --headless "...\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden
                -ExecutionPolicy Bypass -File "<this folder>\watch_x4.ps1"
Why conhost --headless: conhost.exe is a GUI program, so starting it opens no console, and in headless mode it
hosts PowerShell's console without any window (also no hand-off to Windows Terminal). No VBScript/wscript needed.
-ExecutionPolicy Bypass applies to this one PowerShell process only; no policy is changed.
The shortcut's "Run: Minimized" is only a fallback in case --headless were ever ignored.

Usage:  powershell -ExecutionPolicy Bypass -File watcher_install.ps1 [-NoStart]
#>
param(
    [string]$ShortcutName = 'X4 Companion Watcher',
    [string]$StartupDir = '',   # for testing only; default is the real Startup folder
    [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$watcher = Join-Path $here 'watch_x4.ps1'
if (-not $StartupDir) { $StartupDir = [Environment]::GetFolderPath('Startup') }
$lnk = Join-Path $StartupDir "$ShortcutName.lnk"

$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = "--headless `"$ps`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watcher`""

# WScript.Shell is only the COM helper that writes the .lnk file; the shortcut itself does not use scripting hosts.
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = $conhost
$s.Arguments = $arguments
$s.WorkingDirectory = $here
$s.WindowStyle = 7          # minimized, not activated (fallback only)
$s.Description = 'Starts the X4 Companion server and window when X4: Foundations starts'
$s.Save()
Write-Host "Shortcut created: $lnk"

if (-not $NoStart) {
    # Start it now, detached (created by WMI, so it does not die with this PowerShell window).
    # If a watcher already runs, the new one exits at once (single-instance mutex).
    $si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = "`"$conhost`" $arguments"; CurrentDirectory = $here; ProcessStartupInformation = $si }
    if ($r.ReturnValue -ne 0) { throw "starting the watcher failed (Win32_Process.Create code $($r.ReturnValue))" }
    Write-Host "Watcher started (conhost pid $($r.ProcessId)). Log: $(Join-Path $here 'logs\watcher.log')"
}
