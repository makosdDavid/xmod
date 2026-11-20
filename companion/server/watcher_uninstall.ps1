<#
Removes the X4 Companion watcher autostart shortcut and stops running watchers.
Only the watcher is stopped (PowerShell processes whose command line runs THIS folder's watch_x4.ps1, by PID);
the companion server, the companion window and the game are left alone.

Usage:  powershell -ExecutionPolicy Bypass -File watcher_uninstall.ps1
#>
param(
    [string]$ShortcutName = 'X4 Companion Watcher',
    [string]$StartupDir = ''   # for testing only; default is the real Startup folder
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$watcher = Join-Path $here 'watch_x4.ps1'
if (-not $StartupDir) { $StartupDir = [Environment]::GetFolderPath('Startup') }
$lnk = Join-Path $StartupDir "$ShortcutName.lnk"

if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk; Write-Host "Shortcut removed: $lnk" }
else { Write-Host "No shortcut at $lnk" }

$procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
           Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($watcher, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
foreach ($p in $procs) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "Watcher stopped (pid $($p.ProcessId))"
}
if (-not $procs) { Write-Host 'No running watcher found' }
