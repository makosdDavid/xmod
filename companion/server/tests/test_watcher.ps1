<#
Tests for watch_x4.ps1 with a FAKE game, port, server and browser - the real game, server and window are not touched.
  fake game     : a tiny windowless exe compiled into <work>\gameA\X4.exe (right path) and gameB\X4.exe (wrong path)
  fake server   : a python http listener on the test port; every start appends its pid to starts.txt
  fake browser  : a windowless-looking exe (fully transparent, off-screen, no taskbar button, never activated)
                  whose visible top-level window carries the test title; every start appends to marker.txt
Every process the test starts (directly or through the watcher) is stopped by PID at the end.
Usage:  powershell -ExecutionPolicy Bypass -File tests\test_watcher.ps1 [-Work D:\X4-backups\work\watcher-test] [-Port 8796]
#>
param([string]$Work = 'D:\X4-backups\work\watcher-test', [int]$Port = 8796)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$watcher = Join-Path $root 'watch_x4.ps1'
$py = Join-Path $root '.venv\Scripts\python.exe'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$run = Join-Path $Work (Get-Date -Format 'yyyyMMdd-HHmmss')
$dirs = 'gameA', 'gameB', 'bin', 'state', 'logs', 'startup'
$dirs | ForEach-Object { New-Item -ItemType Directory -Force (Join-Path $run $_) | Out-Null }
$gameA = "$run\gameA\X4.exe"; $gameB = "$run\gameB\X4.exe"
$starts = "$run\starts.txt"; $marker = "$run\marker.txt"; $wlog = "$run\logs\watcher.log"
$mutexName = 'Local\X4CompanionWatcherTest'
$title = 'X4 Companion TEST'
$pass = 0; $fail = 0; $tracked = New-Object System.Collections.ArrayList

function Check([string]$name, [bool]$ok) {
    if ($ok) { $script:pass++; Write-Host "PASS  $name" } else { $script:fail++; Write-Host "FAIL  $name" -ForegroundColor Red }
}
function Lines($f) { if (Test-Path $f) { @(Get-Content $f | Where-Object { $_ }).Count } else { 0 } }
function LastPid($f) { [int]((@(Get-Content $f | Where-Object { $_ }))[-1] -split '\|')[0] }
function LogCount([string]$text) { if (Test-Path $wlog) { @(Select-String -Path $wlog -SimpleMatch $text).Count } else { 0 } }
function Wait-Until([scriptblock]$cond, [int]$sec = 30) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $sec) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 250 }
    return [bool](& $cond)
}
function Test-Port {
    $c = New-Object Net.Sockets.TcpClient
    try { $ar = $c.BeginConnect('127.0.0.1', $Port, $null, $null); if ($ar.AsyncWaitHandle.WaitOne(500)) { $c.EndConnect($ar); $true } else { $false } }
    catch { $false } finally { $c.Close() }
}
function Alive([int]$id) { [bool](Get-Process -Id $id -ErrorAction SilentlyContinue) }

# Safety: never stop the real game, a Brave process or the live companion server (owner of 127.0.0.1:8788).
$realGame = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent (Split-Path -Parent $root)) 'X4.exe'))
$liveServer = @(netstat -ano | Select-String -Pattern '127\.0\.0\.1:8788\s+\S+\s+LISTENING\s+(\d+)' | ForEach-Object { [int]$_.Matches[0].Groups[1].Value })
function Stop-Pid([int]$id) {
    if (-not $id -or $id -eq $PID) { return }
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $p) { return }
    $path = $null; try { $path = $p.Path } catch { }
    if ($p.ProcessName -eq 'brave' -or $liveServer -contains $id -or ($path -and $path -ieq $realGame)) {
        Write-Host "refusing to stop protected pid $id ($($p.ProcessName))"; return }
    try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { }   # may have exited meanwhile
}
function Start-Hidden([string]$exe, [string]$arguments) {
    $si = New-Object Diagnostics.ProcessStartInfo($exe, $arguments)
    $si.UseShellExecute = $false; $si.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($si); [void]$tracked.Add($p.Id); return $p
}
function Start-Watcher([string]$extra = '') {
    Start-Hidden $psExe ("-NoProfile -ExecutionPolicy Bypass -File `"$watcher`" -GameExe `"$gameA`" -Port $Port " +
        "-StateDir `"$run\state`" -LogDir `"$run\logs`" -MutexName $mutexName -PollSeconds 1 $extra")
}
function Kill-Windows { if (Test-Path $marker) { Get-Content $marker | Where-Object { $_ } | ForEach-Object { Stop-Pid ([int](($_ -split '\|')[0])) } } }
function Kill-Servers {
    # stub python pids, then the conhost/cmd launchers the watcher logged
    if (Test-Path $starts) { Get-Content $starts | Where-Object { $_ } | ForEach-Object { Stop-Pid ([int]$_) } }
    if (Test-Path $wlog) { Select-String -Path $wlog -Pattern 'server launched \(pid (\d+)\)' | ForEach-Object { Stop-Pid ([int]$_.Matches[0].Groups[1].Value) } }
}

if (Test-Port) { throw "test port $Port is already in use - pick another with -Port" }

# ---- build fakes ----
Add-Type -OutputType WindowsApplication -OutputAssembly $gameA -TypeDefinition @'
public static class FakeGame { public static void Main() { System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite); } }
'@
Copy-Item $gameA $gameB
Copy-Item $gameA "$run\bin\control.exe"
Add-Type -OutputType WindowsApplication -OutputAssembly "$run\bin\stubwin.exe" -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System; using System.IO; using System.Drawing; using System.Windows.Forms;
public class StubForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }                 // never steal focus
    protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80; return p; } } // NOACTIVATE|TOOLWINDOW
}
public static class StubBrowser {
    [STAThread] public static void Main(string[] a) {
        File.AppendAllText(a[0], System.Diagnostics.Process.GetCurrentProcess().Id + "|" + string.Join(" ", a) + Environment.NewLine);
        var f = new StubForm { Text = a[1], FormBorderStyle = FormBorderStyle.None, StartPosition = FormStartPosition.Manual,
                               Location = new Point(-32000, -32000), Size = new Size(1, 1), Opacity = 0, ShowInTaskbar = false };
        Application.Run(f);
    }
}
'@
Set-Content -Encoding ASCII "$run\bin\stub_server.py" @'
import sys, os, http.server
port, starts = int(sys.argv[1]), sys.argv[2]
with open(starts, "a") as f:
    f.write(f"{os.getpid()}\n")
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"<title>stub</title>")
    def log_message(self, *a):
        pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
'@
@{ port = $Port; windowTitle = $title; serverStartTimeoutSec = 20; browserExe = "$run\bin\stubwin.exe"
   browserArgs = @($marker, $title, '--app={url}'); serverCommand = @($py, "$run\bin\stub_server.py", "$Port", $starts)
} | ConvertTo-Json | Set-Content -Encoding UTF8 "$run\state\watcher.json"

$job = [IntPtr]::Zero
try {
    # ---- loop watcher W1 ----
    $w1 = Start-Watcher
    Check 'watcher starts and logs' (Wait-Until { (LogCount 'watcher start (loop)') -ge 1 } 30)

    Start-Sleep 3
    Check 'no game -> no server started' ((Lines $starts) -eq 0)
    Check 'no game -> no window opened' ((Lines $marker) -eq 0)

    $gB = Start-Hidden $gameB ''
    Start-Sleep 3
    Check 'same name, wrong exe path -> ignored (no server)' ((Lines $starts) -eq 0)
    Check 'same name, wrong exe path -> ignored (no window)' ((Lines $marker) -eq 0)

    $gA = Start-Hidden $gameA ''
    Check 'game starts -> window opened' (Wait-Until { (Lines $marker) -ge 1 } 40)
    Check 'game starts -> server started once' ((Lines $starts) -eq 1)
    Check 'game starts -> port answers' (Test-Port)
    Check 'game starts -> window opened once' ((Lines $marker) -eq 1)
    Check 'game starts -> log line' ((LogCount 'server started, listening after') -eq 1)

    # restart while the window still exists
    Stop-Pid $gA.Id
    Check 'game exit logged' (Wait-Until { (LogCount 'game exited') -ge 1 } 10)
    Check 'game exit -> server left running' (Test-Port)
    Check 'game exit -> window left open' (Alive (LastPid $marker))
    $gA = Start-Hidden $gameA ''
    Check 'game restart evaluated' (Wait-Until { (LogCount 'game running,') -ge 2 } 15)
    Check 'restart, window present -> not opened again' ((Lines $marker) -eq 1)
    Check 'restart, server listening -> not started again' ((Lines $starts) -eq 1)
    Check 'restart -> "nothing to do" logged' ((LogCount '-> nothing to do') -ge 1)

    # user closes the window while the game keeps running
    Kill-Windows
    Start-Sleep 4
    Check 'window closed while game runs -> not reopened' ((Lines $marker) -eq 1)

    # game restarts without a window -> opened again, server not started again
    Stop-Pid $gA.Id
    [void](Wait-Until { (LogCount 'game exited') -ge 2 } 10)
    $gA = Start-Hidden $gameA ''
    Check 'restart, no window -> opened again' (Wait-Until { (Lines $marker) -ge 2 } 20)
    Check 'restart, no window -> server still not started again' ((Lines $starts) -eq 1)

    # second instance exits
    $w2 = Start-Watcher '-Once'
    Check 'second instance exits by itself' ($w2.WaitForExit(30000))
    Check 'second instance logs why' ((LogCount 'another watcher is already running') -ge 1)
    Check 'second instance did nothing' ((Lines $marker) -eq 2 -and (Lines $starts) -eq 1)
    Stop-Pid $w1.Id

    # watcher start while game runs and server already listens (no window)
    Kill-Windows
    $w3 = Start-Watcher '-Once'
    [void]$w3.WaitForExit(60000)
    Check 'start with game running -> window opened' ((Lines $marker) -eq 3)
    Check 'start with server listening -> server not started' ((Lines $starts) -eq 1)

    # DryRun: nothing running except the game
    Kill-Windows; Kill-Servers
    Check 'test server stopped' (Wait-Until { -not (Test-Port) } 10)
    $w4 = Start-Watcher '-Once -DryRun'
    [void]$w4.WaitForExit(60000)
    Check 'DryRun logs would-start-server' ((LogCount 'DRY-RUN: would start server') -ge 1)
    Check 'DryRun logs would-open-window' ((LogCount 'DRY-RUN: would open window') -ge 1)
    Check 'DryRun starts no server' ((Lines $starts) -eq 1 -and -not (Test-Port))
    Check 'DryRun opens no window' ((Lines $marker) -eq 3)

    # window detection by command line (--app=<url>) when the title is something else (page not loaded yet)
    $sw = Start-Hidden "$run\bin\stubwin.exe" "`"$run\other.txt`" loading --app=http://127.0.0.1:$Port"
    [void](Wait-Until { Test-Path "$run\other.txt" } 10); Start-Sleep 1
    $w5 = Start-Watcher '-Once -DryRun'
    [void]$w5.WaitForExit(60000)
    Check 'window found via --app command line' ((LogCount "window present (app window of pid $($sw.Id)") -ge 1)
    Stop-Pid $sw.Id

    # detached launch: watcher in a kill-on-close job; kill its tree; launched server + window must survive
    Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class TestJob {
    [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a, b; public uint LimitFlags; public UIntPtr c, d; public uint e; public UIntPtr f; public uint g, h; }
    [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IO Io; public UIntPtr a, b, c, d; }
    [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr a, string n);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, int l);
    [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    public static IntPtr KillOnClose() {
        var j = CreateJobObject(IntPtr.Zero, null); var i = new EXT(); i.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
        SetInformationJobObject(j, 9, ref i, Marshal.SizeOf(typeof(EXT))); return j; }
}
'@
    Kill-Windows
    $job = [TestJob]::KillOnClose()
    $w6 = Start-Watcher
    Check 'watcher assigned to job' ([TestJob]::AssignProcessToJobObject($job, $w6.Handle))
    $ctl = Start-Hidden "$run\bin\control.exe" ''
    [void][TestJob]::AssignProcessToJobObject($job, $ctl.Handle)
    Check 'detach: watcher launched server' (Wait-Until { (Lines $starts) -ge 2 -and (Test-Port) } 40)
    Check 'detach: watcher launched window' (Wait-Until { (Lines $marker) -ge 4 } 20)
    $srvPid = LastPid $starts; $winPid = LastPid $marker
    & taskkill.exe /T /F /PID $w6.Id 2>&1 | Out-Null
    [void][TestJob]::CloseHandle($job); $job = [IntPtr]::Zero
    Start-Sleep 2
    Check 'detach: launching watcher is dead' (-not (Alive $w6.Id))
    Check 'detach: control child in the job was killed (harness works)' (-not (Alive $ctl.Id))
    Check 'detach: server survived' ((Alive $srvPid) -and (Test-Port))
    Check 'detach: window survived' (Alive $winPid)

    # uninstall: test shortcut in a test folder + a watcher started exactly like the shortcut does (conhost --headless)
    $lnkName = 'X4 Companion Watcher TEST'
    $sh = New-Object -ComObject WScript.Shell; $s = $sh.CreateShortcut("$run\startup\$lnkName.lnk"); $s.TargetPath = "$env:SystemRoot\System32\conhost.exe"; $s.Save()
    $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
    $cl = "`"$conhost`" --headless `"$psExe`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watcher`" " +
          "-GameExe `"$gameA`" -Port $Port -StateDir `"$run\state`" -LogDir `"$run\logs`" -MutexName $mutexName -PollSeconds 1"
    $si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cl; CurrentDirectory = $root; ProcessStartupInformation = $si }
    [void]$tracked.Add([int]$r.ProcessId)
    $before = LogCount 'watcher start (loop)'
    Check 'conhost --headless launch runs the watcher' (Wait-Until { (LogCount 'watcher start (loop)') -gt $before } 30)
    $wp = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like "*$watcher*" })
    $wp | ForEach-Object { [void]$tracked.Add([int]$_.ProcessId) }
    $foreign = @($wp | Where-Object { $_.CommandLine -notlike "*$mutexName*" })
    $ids = @($wp | ForEach-Object { [int]$_.ProcessId }) + [int]$r.ProcessId
    Check 'headless watcher (+ its conhost) has no visible window' (-not (Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }))
    if ($foreign) { Write-Host "SKIP  uninstall test: a non-test watcher is running (pid $($foreign.ProcessId -join ','))" }
    else {
        & $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'watcher_uninstall.ps1') -ShortcutName $lnkName -StartupDir "$run\startup" | Out-Host
        Start-Sleep 1
        Check 'uninstall removed the test shortcut' (-not (Test-Path "$run\startup\$lnkName.lnk"))
        Check 'uninstall stopped the watcher' (-not ($wp | Where-Object { Alive $_.ProcessId }))
    }
}
finally {
    if ($job -ne [IntPtr]::Zero) { [void][TestJob]::CloseHandle($job) }
    Kill-Windows; Kill-Servers
    $tracked | ForEach-Object { Stop-Pid $_ }
    Start-Sleep 1
    $left = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$run\*" -or ($_.CommandLine -and $_.CommandLine -like "*$run*") })
    $left | ForEach-Object { Stop-Pid ([int]$_.ProcessId) }
    Write-Host ("leftover test processes after cleanup: {0}" -f @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$run\*" -or ($_.CommandLine -and $_.CommandLine -like "*$run*") }).Count)
    Write-Host "work dir: $run"
}
Write-Host "RESULT: $pass passed, $fail failed"
if ($fail) { exit 1 }
