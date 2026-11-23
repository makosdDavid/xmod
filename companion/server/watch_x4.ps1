<#
X4 Companion watcher.

Polls every few seconds for the game process (X4.exe in the game root, two folders above this script).
When the game goes from "not running" to "running" (and once at watcher start if it already runs):
  1. if nothing listens on the companion port, start the server hidden and wait until the port answers;
  2. if no companion window exists, open one.
When the game exits, server and window are left alone. A window the user closes while the game keeps
running is not reopened (we only act on the start transition).

Everything this script launches is started through WMI (Win32_Process.Create), so it is NOT a child of
this script: it keeps running when the watcher, or whatever started the watcher, exits or is killed.

Machine settings: state\watcher.json (see README). Log: logs\watcher.log (rotated at 1 MB).

Testing:  -Once  evaluate once and exit;  -DryRun  log what would be done, start/open nothing.
          -ProcessName / -GameExe / -Port / -StateDir / -LogDir / -MutexName / -PollSeconds, plus the config keys
          serverCommand / browserArgs / windowTitle, let the tests use a fake game, port, server and browser
          without touching the real ones.
#>
[CmdletBinding()]
param(
    [switch]$Once,
    [switch]$DryRun,
    [string]$ProcessName = 'X4',
    [string]$GameExe = '',          # default: <game root>\X4.exe   ($PSScriptRoot is empty here in PS 5.1)
    [int]$Port = 0,                 # 0 = from config, else 8788
    [string]$StateDir = '',         # default: <script dir>\state
    [string]$LogDir = '',           # default: <script dir>\logs
    [string]$MutexName = 'Local\X4CompanionWatcher',
    [double]$PollSeconds = 3,
    [switch]$OpenNow                # act once as if the game had just started (server if needed + window if none),
                                    # whether or not the game runs and ignoring skipWindowFlag; takes no mutex
                                    # (an explicit "open the dashboard" request, e.g. from the x4switch manager)
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $GameExe)  { $GameExe  = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'X4.exe' }
if (-not $StateDir) { $StateDir = Join-Path $here 'state' }
if (-not $LogDir)   { $LogDir   = Join-Path $here 'logs' }
$GameExe = [IO.Path]::GetFullPath($GameExe)
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logFile = Join-Path $LogDir 'watcher.log'
$serverLog = Join-Path $LogDir 'watcher-server.log'

function Write-Log([string]$msg) {
    try {
        # size cap: keep one previous file (watcher.log.1)
        if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1MB) { Move-Item -Force $logFile "$logFile.1" }
        $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $PID, $msg
        [IO.File]::AppendAllText($logFile, $line + "`r`n", [Text.Encoding]::UTF8)
        if ($Once) { Write-Host $line }
    } catch { }
}

# ---- config (state\watcher.json); every key is optional ----
$cfg = @{}
$cfgFile = Join-Path $StateDir 'watcher.json'
if (Test-Path $cfgFile) {
    try { (Get-Content -Raw $cfgFile | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cfg[$_.Name] = $_.Value } }
    catch { Write-Log "config $cfgFile unreadable, using defaults: $($_.Exception.Message)" }
}
function Get-Cfg($name, $default) { if ($null -ne $cfg[$name] -and "$($cfg[$name])" -ne '') { $cfg[$name] } else { $default } }

if ($Port -le 0) { $Port = [int](Get-Cfg 'port' 8788) }
$url          = "http://127.0.0.1:$Port"
$windowTitle  = [string](Get-Cfg 'windowTitle' 'X4 Companion')
$browserExe   = [string](Get-Cfg 'browserExe' '')
$startTimeout = [int](Get-Cfg 'serverStartTimeoutSec' 60)
$uvCacheDir   = [string](Get-Cfg 'uvCacheDir' $env:UV_CACHE_DIR)

# ---- single instance ----
# A named mutex lives as long as some process holds a handle to it, so it also disappears if a watcher is killed.
# -DryRun changes nothing, so it neither takes nor checks the mutex (it may run next to a real watcher).
if (-not $DryRun -and -not $OpenNow) {
    $createdNew = $false
    $mutex = New-Object Threading.Mutex($false, $MutexName, [ref]$createdNew)
    if (-not $createdNew) { Write-Log 'another watcher is already running - exiting'; exit 0 }
}

# ---- helpers ----
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class X4WatchWin {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    // visible top-level windows as "pid<TAB>title"
    public static List<string> Visible() {
        var r = new List<string>();
        EnumWindows((h, l) => {
            if (IsWindowVisible(h)) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); uint p; GetWindowThreadProcessId(h, out p); r.Add(p + "\t" + sb); }
            return true; }, IntPtr.Zero);
        return r;
    }
}
'@

function Test-GameRunning {
    # name first (cheap), then the full exe path, so an unrelated "X4.exe" elsewhere is ignored
    foreach ($p in @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)) {
        $path = $null
        try { $path = $p.Path } catch { }   # null for processes we may not inspect (e.g. elevated)
        if ($path -and [string]::Equals([IO.Path]::GetFullPath($path), $GameExe, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Test-Port {
    $c = New-Object Net.Sockets.TcpClient
    try {
        $ar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
        if ($ar.AsyncWaitHandle.WaitOne(500)) { $c.EndConnect($ar); return $true }
        return $false
    } catch { return $false } finally { $c.Close() }
}

function Find-CompanionWindow {
    # Returns a short description of an existing companion window, or $null.
    $wins = @([X4WatchWin]::Visible() | ForEach-Object { $a = $_ -split "`t", 2; [pscustomobject]@{ Pid = [int]$a[0]; Title = $a[1] } })
    # 1) title: the page sets "X4 Companion" (pop-outs "X4 Companion - <panel>", normal tabs "... - Brave")
    $t = $wins | Where-Object { $_.Title.StartsWith($windowTitle, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    if ($t) { return "title '$($t.Title)', pid $($t.Pid)" }
    # 2) a process started with --app=<our url> that owns a visible window (covers a page that has not loaded
    #    yet or shows an error, i.e. has a different title)
    $pat = '--app=' + [regex]::Escape($url) + '(/|\s|"|$)'
    $procs = @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%--app=%'" -ErrorAction SilentlyContinue |
               Where-Object { $_.CommandLine -match $pat })
    foreach ($p in $procs) {
        $w = $wins | Where-Object { $_.Pid -eq [int]$p.ProcessId -and $_.Title } | Select-Object -First 1
        if ($w) { return "app window of pid $($p.ProcessId) ('$($w.Title)')" }
    }
    return $null
}

function Join-CommandLine([string[]]$tokens) {
    # quote tokens that contain spaces; tokens must not contain quotes (conhost re-tokenizes the line)
    ($tokens | ForEach-Object { if ($_ -match '"') { throw "quote character not allowed in: $_" }; if ($_ -match '\s' -or $_ -eq '') { '"' + $_ + '"' } else { $_ } }) -join ' '
}

function Start-Detached([string]$commandLine, [bool]$hidden, [string]$cwd = '', [int]$showWindow = -1) {
    # Win32_Process.Create: the new process is created by the WMI service, not as our child, so it is not in our
    # process tree or job object and survives when the watcher is killed. Needs no admin rights for own session.
    $props = @{}
    if ($hidden) { $props.ShowWindow = [uint16]0 }   # SW_HIDE
    elseif ($showWindow -ge 0) { $props.ShowWindow = [uint16]$showWindow }
    if (-not $cwd) { $cwd = $here }
    $si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property $props
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $commandLine; CurrentDirectory = $cwd; ProcessStartupInformation = $si }
    if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed (code $($r.ReturnValue)): $commandLine" }
    return [int]$r.ProcessId
}

function Get-ServerCommandLine {
    if ($cfg['serverCommand']) { $tokens = @($cfg['serverCommand'] | ForEach-Object { [string]$_ }) }   # tests/advanced
    else {
        $uv = [string](Get-Cfg 'uvExe' '')
        if (-not $uv) { $c = Get-Command uv -ErrorAction SilentlyContinue; if ($c) { $uv = $c.Source } else { $uv = 'uv' } }
        $tokens = @($uv, 'run')
        if ($uvCacheDir) { $tokens += @('--cache-dir', $uvCacheDir) }   # same as UV_CACHE_DIR
        $tokens += @('--locked', 'python', 'server.py', '--port', "$Port")
    }
    # conhost --headless: a console without any window (conhost.exe itself is a GUI program, so starting it never
    # flashes a console, and headless mode never hands off to Windows Terminal). cmd only does the log redirect.
    $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
    return (Join-CommandLine (@($conhost, '--headless', $env:ComSpec, '/d', '/c') + $tokens)) + ' >> ' + (Join-CommandLine @($serverLog)) + ' 2>&1'
}

function Get-BrowserCommandLine {
    if (-not $browserExe) {
        # no browser configured: the default browser via the URL (explorer hands it to the shell)
        return (Join-CommandLine @((Join-Path $env:SystemRoot 'explorer.exe'), $url))
    }
    if ($cfg['browserArgs']) { $args2 = @($cfg['browserArgs'] | ForEach-Object { ([string]$_).Replace('{url}', $url) }) }
    else {
        $args2 = @("--app=$url")
        $pos = [string](Get-Cfg 'windowPosition' ''); $size = [string](Get-Cfg 'windowSize' '')
        if ($pos)  { $args2 += "--window-position=$pos" }
        if ($size) { $args2 += "--window-size=$size" }
    }
    return (Join-CommandLine (@($browserExe) + $args2))
}

$script:serverPid = 0   # conhost pid of the server we launched (to never start a second one while it boots)

function Invoke-GameStarted {
    # --- server ---
    $serverUp = Test-Port
    if ($serverUp) { $srv = 'server already listening' }
    elseif ($script:serverPid -and (Get-Process -Id $script:serverPid -ErrorAction SilentlyContinue)) {
        $srv = "server launched earlier (pid $($script:serverPid)) still starting - not starting another"
    } elseif ($DryRun) {
        $srv = 'DRY-RUN: would start server: ' + (Get-ServerCommandLine)
    } else {
        if ((Test-Path $serverLog) -and (Get-Item $serverLog).Length -gt 1MB) { Move-Item -Force $serverLog "$serverLog.1" }
        $cl = Get-ServerCommandLine
        $script:serverPid = Start-Detached $cl $true
        Write-Log "server launched (pid $($script:serverPid)): $cl"
        $sw = [Diagnostics.Stopwatch]::StartNew()
        while (-not $serverUp -and $sw.Elapsed.TotalSeconds -lt $startTimeout) {
            Start-Sleep -Milliseconds 500
            $serverUp = Test-Port
            if (-not $serverUp -and -not (Get-Process -Id $script:serverPid -ErrorAction SilentlyContinue)) { break }
        }
        if ($serverUp) { $srv = 'server started, listening after {0:N1}s' -f $sw.Elapsed.TotalSeconds }
        else { $srv = "server did NOT answer on port $Port (timeout ${startTimeout}s or it exited) - see $serverLog" }
    }
    # --- window ---
    # Optional: another tool (e.g. a cockpit mode that uses every monitor) can ask us not to open the window
    # by creating the file named in the 'skipWindowFlag' setting. The server is still started.
    $skip = [string](Get-Cfg 'skipWindowFlag' '')
    if (-not $OpenNow -and $skip -and (Test-Path -LiteralPath $skip)) { Write-Log "game running, $srv, skip flag $skip present - not opening the window"; return }
    $win = Find-CompanionWindow
    if ($win) { $wtxt = "window present ($win)" }
    elseif ($DryRun) { $wtxt = 'DRY-RUN: would open window: ' + (Get-BrowserCommandLine) }
    elseif (-not $serverUp) { $wtxt = 'no window, not opening one because the server is not reachable' }
    else {
        $cl = Get-BrowserCommandLine
        $bpid = Start-Detached $cl $false
        $wtxt = "window opened (pid $bpid): $cl"
    }
    $tail = ''
    if ($srv -eq 'server already listening' -and $win) { $tail = ' -> nothing to do' }
    Write-Log "game running, $srv, $wtxt$tail"
}

# ---- tablet/phone cockpit extras (game start only, not -OpenNow) ----
# watcher.json: startTelemetryServer (true) / telemetryServerExe / telemetryServerWindow ('minimized' | 'hidden'),
#               startCockpitHelper (true) / cockpitHelperScript
function Get-CfgBool($name, [bool]$default) {
    $v = $cfg[$name]
    if ($null -eq $v -or "$v" -eq '') { return $default }
    if ($v -is [bool]) { return $v }
    return @('1', 'true', 'yes', 'on') -contains "$v".Trim().ToLowerInvariant()
}

function Start-TelemetryServer {
    # third-party X4Telemetry_Server (web cockpits for iPad/phone, port 8080); started only if not already running
    if (-not (Get-CfgBool 'startTelemetryServer' $true)) { return 'telemetry server: disabled in config' }
    $exe = [IO.Path]::GetFullPath([string](Get-Cfg 'telemetryServerExe' 'D:\X4Telemetry_Server\X4Telemetry_Server.exe'))
    if (-not (Test-Path -LiteralPath $exe)) { return "telemetry server: $exe not found - not started" }
    $name = [IO.Path]::GetFileNameWithoutExtension($exe)
    foreach ($p in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
        $path = $null; try { $path = $p.Path } catch { }
        if (-not $path -or [string]::Equals([IO.Path]::GetFullPath($path), $exe, [StringComparison]::OrdinalIgnoreCase)) {
            return "telemetry server already running (pid $($p.Id))"
        }
    }
    # it is a console program: host it in a classic conhost window (minimized, not activated, so the game keeps
    # focus) or in a headless conhost (no window at all)
    $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
    $mode = ([string](Get-Cfg 'telemetryServerWindow' 'minimized')).ToLowerInvariant()
    if ($mode -eq 'hidden') { $cl = Join-CommandLine @($conhost, '--headless', $exe) } else { $cl = Join-CommandLine @($conhost, $exe) }
    $cwd = Split-Path -Parent $exe   # it must run in its own folder (config.json, www\)
    if ($DryRun) { return "DRY-RUN: would start telemetry server ($mode, cwd $cwd): $cl" }
    if ($mode -eq 'hidden') { $tp = Start-Detached $cl $true $cwd } else { $tp = Start-Detached $cl $false $cwd 7 }   # 7 = SW_SHOWMINNOACTIVE
    return "telemetry server started (pid $tp, $mode, cwd $cwd): $cl"
}

function Start-CockpitHelper {
    # tools\x4cockpit_helper\start_helper.ps1: starts the beep/throttle helper (port 8790) detached if the port is free
    if (-not (Get-CfgBool 'startCockpitHelper' $true)) { return 'cockpit helper: disabled in config' }
    $helperScript = [string](Get-Cfg 'cockpitHelperScript' (Join-Path (Split-Path -Parent $here) 'x4cockpit_helper\start_helper.ps1'))
    if (-not (Test-Path -LiteralPath $helperScript)) { return "cockpit helper: $helperScript not found - not started" }
    if ($DryRun) { return "DRY-RUN: would run $helperScript" }
    # runs synchronously in a child PowerShell (it only checks the port, launches the helper via WMI and returns)
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = (& $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helperScript 2>&1 | Out-String).Trim() -replace '\s*\r?\n\s*', ' | ' }
    finally { $ErrorActionPreference = $eap }
    return "cockpit helper (exit $LASTEXITCODE): $out"
}

function Invoke-CockpitExtras([string]$which) {
    try { if ($which -eq 'telemetry') { Write-Log (Start-TelemetryServer) } else { Write-Log (Start-CockpitHelper) } }
    catch { Write-Log "error ($which): $($_.Exception.Message)" }
}

# ---- main loop ----
$mode = @(); if ($Once) { $mode += 'once' }; if ($DryRun) { $mode += 'dry-run' }; if ($OpenNow) { $mode += 'open-now' }
Write-Log ("watcher start ({0}) game={1} port={2} poll={3}s" -f ($(if ($mode) { $mode -join ',' } else { 'loop' })), $GameExe, $Port, $PollSeconds)
if ($OpenNow) {
    $Once = $true   # log lines also to the console
    Write-Log 'open-now requested'
    try { Invoke-GameStarted } catch { Write-Log "error: $($_.Exception.Message)"; exit 1 }
    exit 0
}
$wasRunning = $false
while ($true) {
    try {
        $running = Test-GameRunning
        if ($running -and -not $wasRunning) {
            Invoke-CockpitExtras 'telemetry'   # instant (no wait), so it goes first
            try { Invoke-GameStarted } finally { Invoke-CockpitExtras 'helper' }
        }
        elseif (-not $running -and $wasRunning) { Write-Log 'game exited - leaving server and window alone' }
        elseif ($Once -and -not $running) { Write-Log 'game not running -> nothing to do' }
        $wasRunning = $running
    } catch { Write-Log "error: $($_.Exception.Message)" }
    if ($Once) { break }
    Start-Sleep -Milliseconds ([int]($PollSeconds * 1000))
}
