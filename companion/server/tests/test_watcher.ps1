<#
Tests for watch_x4.ps1 with a FAKE game, port, server and browser - the real game, server and window are not touched.
  fake game     : a tiny windowless exe compiled into <work>\gameA\X4.exe (right path) and gameB\X4.exe (wrong path)
  fake server   : a python http listener on the test port; every start appends its pid to starts.txt
  fake browser  : a windowless-looking exe (fully transparent, off-screen, no taskbar button, never activated)
                  whose visible top-level window carries the test title; every start appends to marker.txt
  fake telemetry: <work>\th\telem\X4TelemTest.exe (a sleeping console exe, the "configured" server) plus a copy of it in
                  th\telemcopy (same file name, other folder: must never be stopped); faketelem.exe provides the port
                  (minimal WebSocket server on a free port, push/silent) and a test pipe (busy/free), switched via th\mode.txt;
                  it logs every TCP accept / WebSocket handshake to th\events.txt. The real telemetry server, its port
                  8080 and pipe x4telemetry are never touched (every test config names the fake port and pipe).
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

# Safety: never stop the real game, a Brave process, the real telemetry server or the live companion server (owner of 127.0.0.1:8788).
$realGame = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent (Split-Path -Parent $root)) 'X4.exe'))
$realTelemetry = 'D:\X4Telemetry_Server\X4Telemetry_Server.exe'
$liveServer = @(netstat -ano | Select-String -Pattern '127\.0\.0\.1:8788\s+\S+\s+LISTENING\s+(\d+)' | ForEach-Object { [int]$_.Matches[0].Groups[1].Value })
function Stop-Pid([int]$id) {
    if (-not $id -or $id -eq $PID) { return }
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $p) { return }
    $path = $null; try { $path = $p.Path } catch { }
    if ($p.ProcessName -eq 'brave' -or $liveServer -contains $id -or ($path -and ($path -ieq $realGame -or $path -ieq $realTelemetry))) {
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

# ---- telemetry health-check helpers (fake server in $th; never the real one) ----
$th = "$run\th"
$telemExe = "$th\telem\X4TelemTest.exe"; $telemCopy = "$th\telemcopy\X4TelemTest.exe"; $gameT = "$th\gameT\X4.exe"
$tCtl = "$th\mode.txt"; $tEv = "$th\events.txt"
$tPipe = 'x4telemtest_' + (Split-Path -Leaf $run)
$thMutex = 'Local\X4CompanionWatcherTestTH'
function Get-FreePort { $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0); $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); $p }
function Test-TPort([int]$p) {
    $c = New-Object Net.Sockets.TcpClient
    try { $ar = $c.BeginConnect('127.0.0.1', $p, $null, $null); if ($ar.AsyncWaitHandle.WaitOne(500)) { $c.EndConnect($ar); $true } else { $false } }
    catch { $false } finally { $c.Close() }
}
function TelemPids {   # processes running exactly the configured fake telemetry exe
    @(Get-Process -Name X4TelemTest -ErrorAction SilentlyContinue | Where-Object { $p = $null; try { $p = $_.Path } catch { }; $p -ieq $telemExe } | ForEach-Object { $_.Id })
}
function EvCount([string]$kind) {   # lines in the fake's event file ('accept' = any TCP connect, 'ws' = WebSocket handshake)
    if (-not (Test-Path $tEv)) { return 0 }
    $fs = New-Object IO.FileStream($tEv, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try { $txt = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
    @($txt -split "`n" | Where-Object { $_.Trim() -eq $kind }).Count
}
function Write-Mode([string]$m) {
    for ($i = 0; $i -lt 40; $i++) { try { [IO.File]::WriteAllText($tCtl, $m); return } catch { Start-Sleep -Milliseconds 50 } }
    throw "cannot write $tCtl"
}
function Set-Mode([string]$m) {   # '<push|silent> <busy|free>'; waits until the pipe shows the wanted state
    Write-Mode $m
    $want = if ($m -like '*busy*') { 'busy' } else { 'free' }
    [void](Wait-Until { [X4TestPipe]::State($tPipe) -eq $want } 10)
    Start-Sleep -Milliseconds 300
}
function New-THRun([string]$name, [hashtable]$telem) {   # own state + log dir per watcher run
    $d = "$th\$name"; New-Item -ItemType Directory -Force "$d\state", "$d\logs" | Out-Null
    $c = @{ port = $Port; windowTitle = $title; serverStartTimeoutSec = 20; browserExe = "$run\bin\stubwin.exe"
            browserArgs = @($marker, $title, '--app={url}'); serverCommand = @($py, "$run\bin\stub_server.py", "$Port", $starts)
            startCockpitHelper = $false }
    foreach ($k in $telem.Keys) { $c[$k] = $telem[$k] }
    $c | ConvertTo-Json | Set-Content -Encoding UTF8 "$d\state\watcher.json"
    return $d
}
function Start-THWatcher([string]$dir, [string]$extra = '') {
    Start-Hidden $psExe ("-NoProfile -ExecutionPolicy Bypass -File `"$watcher`" -GameExe `"$gameT`" -Port $Port " +
        "-StateDir `"$dir\state`" -LogDir `"$dir\logs`" -MutexName $thMutex -PollSeconds 1 $extra")
}
function THLog([string]$dir, [string]$text) { $f = "$dir\logs\watcher.log"; if (Test-Path $f) { @(Select-String -Path $f -SimpleMatch $text).Count } else { 0 } }
function THLogRx([string]$dir, [string]$rx) { $f = "$dir\logs\watcher.log"; if (Test-Path $f) { @(Select-String -Path $f -Pattern $rx).Count } else { 0 } }
function THLogInOrder([string]$dir, [string[]]$texts) {   # first occurrences appear in this order
    $lines = @(Get-Content "$dir\logs\watcher.log"); $i = -1
    foreach ($t in $texts) {
        $j = -1; for ($k = $i + 1; $k -lt $lines.Count; $k++) { if ($lines[$k].Contains($t)) { $j = $k; break } }
        if ($j -lt 0) { return $false }; $i = $j
    }
    return $true
}
function Stop-THWatcher($w) { Stop-Pid $w.Id; [void](Wait-Until { -not (Alive $w.Id) } 10) }

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
   startTelemetryServer = $false; startCockpitHelper = $false   # never start the REAL telemetry server / cockpit helper
} | ConvertTo-Json | Set-Content -Encoding UTF8 "$run\state\watcher.json"

# fake telemetry server: the exe the watcher manages (a console program like the real one), a same-name copy elsewhere,
# and faketelem.exe for port + pipe (both switchable through the mode file)
'telem', 'telemcopy', 'gameT' | ForEach-Object { New-Item -ItemType Directory -Force (Join-Path $th $_) | Out-Null }
Add-Type -OutputType ConsoleApplication -OutputAssembly $telemExe -TypeDefinition @'
public static class FakeTelemetryExe { public static void Main() { System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite); } }
'@
Copy-Item $telemExe $telemCopy
Copy-Item $gameA $gameT
Add-Type -OutputType WindowsApplication -OutputAssembly "$run\bin\faketelem.exe" -TypeDefinition @'
using System; using System.IO; using System.Net; using System.Net.Sockets; using System.IO.Pipes;
using System.Text; using System.Threading; using System.Security.Cryptography;
// args: port pipeName modeFile eventFile. mode file: "push|silent busy|free" (re-read every 50 ms)
public static class FakeTelemetry {
    static string ctl, events; static volatile string mode = "push busy"; static readonly object evLock = new object();
    static void Ev(string s) {
        lock (evLock) { try { using (var f = new FileStream(events, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) {
            var b = Encoding.ASCII.GetBytes(s + "\n"); f.Write(b, 0, b.Length); } } catch { } }
    }
    static bool Has(string w) { return (" " + mode + " ").Contains(" " + w + " "); }
    static void ReadMode() {
        try { using (var f = new FileStream(ctl, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
              using (var r = new StreamReader(f)) { var m = r.ReadToEnd().Trim(); if (m.Length > 0) mode = m; } } catch { }
    }
    public static void Main(string[] a) {
        int port = int.Parse(a[0]); string pipe = a[1]; ctl = a[2]; events = a[3];
        ReadMode();
        new Thread(() => { while (true) { ReadMode(); Thread.Sleep(50); } }) { IsBackground = true }.Start();
        var l = new TcpListener(IPAddress.Loopback, port); l.Start();
        new Thread(() => { while (true) {
            TcpClient c; try { c = l.AcceptTcpClient(); } catch { Thread.Sleep(100); continue; }
            Ev("accept"); new Thread(() => Serve(c)) { IsBackground = true }.Start(); } }) { IsBackground = true }.Start();
        Ev("ready");
        PipeLoop(pipe);
    }
    static void Serve(TcpClient c) {   // minimal WebSocket server: handshake, then a text frame every 100 ms while "push"
        try {
            var s = c.GetStream(); s.ReadTimeout = 5000;
            var req = new StringBuilder(); var buf = new byte[4096];
            while (!req.ToString().Contains("\r\n\r\n")) { int n = s.Read(buf, 0, buf.Length); if (n <= 0) return; req.Append(Encoding.ASCII.GetString(buf, 0, n)); }
            string key = null;
            foreach (var line in req.ToString().Split(new[] { "\r\n" }, StringSplitOptions.None))
                if (line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase)) key = line.Substring(18).Trim();
            if (key == null) return;
            string acc; using (var sha = SHA1.Create()) acc = Convert.ToBase64String(sha.ComputeHash(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            var resp = Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + "\r\n\r\n");
            s.Write(resp, 0, resp.Length);
            Ev("ws");
            int i = 0;
            while (true) {
                if (c.Client.Poll(0, SelectMode.SelectRead)) { if (c.Client.Available == 0) return; s.Read(buf, 0, buf.Length); }   // gone / drain
                if (Has("push")) { var p = Encoding.ASCII.GetBytes("{\"n\":" + (i++) + "}"); var fr = new byte[2 + p.Length]; fr[0] = 0x81; fr[1] = (byte)p.Length;
                                   Array.Copy(p, 0, fr, 2, p.Length); s.Write(fr, 0, fr.Length); }
                Thread.Sleep(100);
            }
        } catch { } finally { try { c.Close(); } catch { } }
    }
    static void PipeLoop(string pipe) {   // one instance; "busy" = our own client holds it, "free" = waiting for a client
        while (true) {
            NamedPipeServerStream s = null; NamedPipeClientStream c = null;
            try {
                s = new NamedPipeServerStream(pipe, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None);
                while (!Has("busy")) Thread.Sleep(50);
                c = new NamedPipeClientStream(".", pipe, PipeDirection.InOut); c.Connect(5000); s.WaitForConnection();
                while (Has("busy")) Thread.Sleep(50);
            } catch (Exception e) { Ev("pipe-error " + e.Message.Replace("\r", " ").Replace("\n", " ")); Thread.Sleep(200); }
            finally { if (c != null) c.Dispose(); if (s != null) s.Dispose(); }
        }
    }
}
'@
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class X4TestPipe {   // same probe as the watcher's X4WatchPipe (WaitNamedPipe never connects)
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool WaitNamedPipe(string name, uint timeoutMs);
    public static string State(string pipeName) {
        if (WaitNamedPipe(@"\\.\pipe\" + pipeName, 1)) return "free";
        return Marshal.GetLastWin32Error() == 2 ? "none" : "busy";
    }
}
'@

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
    $wp | Where-Object { $_.CommandLine -like "*$mutexName*" } | ForEach-Object { [void]$tracked.Add([int]$_.ProcessId) }   # only OUR watchers: never stop the user's real watcher (same script path)
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

    # ---- telemetry server health check (fake exe, fake port + pipe; own game, mutex, state and log dirs) ----
    $tPort = Get-FreePort; $deadPort = Get-FreePort
    while ($deadPort -eq $tPort -or $deadPort -eq $Port) { $deadPort = Get-FreePort }
    $thBase = @{ startTelemetryServer = $true; telemetryServerExe = $telemExe; telemetryServerWindow = 'hidden'; telemetryHealthCheck = $true
                 telemetryHealthIntervalSec = 1; telemetryHealthFailures = 3; telemetryPort = $tPort; telemetryPipe = $tPipe }
    Write-Mode 'push busy'
    $ft = Start-Hidden "$run\bin\faketelem.exe" "$tPort $tPipe `"$tCtl`" `"$tEv`""
    Check 'telemetry fake: port answers, pipe busy' (Wait-Until { (Test-TPort $tPort) -and [X4TestPipe]::State($tPipe) -eq 'busy' } 20)
    $cp = Start-Hidden $telemCopy ''        # same file name, other folder: must survive every restart
    $gT = Start-Hidden $gameT ''
    $dA = New-THRun 'main' $thBase
    $wA = Start-THWatcher $dA
    Check 'telemetry: game start -> configured exe started once (hidden, own folder)' (Wait-Until {
        (THLog $dA 'telemetry server started (pid') -ge 1 -and @(TelemPids).Count -eq 1 } 30)
    Check 'telemetry: start line says hidden + cwd' ((THLog $dA ", hidden, cwd $th\telem)") -ge 1)
    $t0 = @(TelemPids) | Select-Object -First 1

    # 1. healthy: pipe busy + data flows
    $ws0 = EvCount 'ws'
    Check 'health ok: WebSocket probed by the checks' (Wait-Until { (EvCount 'ws') -ge $ws0 + 3 } 30)
    Check 'health ok: no failed check logged' ((THLog $dA 'telemetry server check') -eq 0)
    Check 'health ok: no restart, same pid keeps running' ((THLog $dA 'telemetry server restarted') -eq 0 -and (@(TelemPids) -join ',') -eq "$t0")

    # 2. waiting: pipe free + WebSocket silent (pipe first, so no probe in flight sees a half switch)
    Set-Mode 'push free'; Start-Sleep 2
    Set-Mode 'silent free'; Start-Sleep 1
    $ws1 = EvCount 'ws'; $ac1 = EvCount 'accept'
    Check 'health waiting: checks keep running (port probed)' (Wait-Until { (EvCount 'accept') -ge $ac1 + 3 } 30)
    Check 'health waiting: no WebSocket probe (free pipe is enough)' ((EvCount 'ws') -eq $ws1)
    Check 'health waiting: no failed check, no restart, same pid' ((THLog $dA 'telemetry server check') -eq 0 -and
        (THLog $dA 'telemetry server restarted') -eq 0 -and (@(TelemPids) -join ',') -eq "$t0")

    # 3. stuck: pipe busy + WebSocket silent -> restart after 3 checks in a row
    Set-Mode 'silent busy'
    Check 'health stuck: restarted after 3 failed checks' (Wait-Until { (THLog $dA 'telemetry server restarted') -ge 1 } 60)
    Check 'health stuck: log has check 1/3, 2/3, then restarted' (THLogInOrder $dA @('telemetry server check 1/3', 'telemetry server check 2/3', 'telemetry server restarted'))
    Check 'health stuck: reason is the silent pipe client' ((THLog $dA 'check 1/3: stuck: pipe has a client but only 0 message(s)') -ge 1)
    Check 'health stuck: old pid gone, a new process of the configured exe runs' (Wait-Until {
        $p = @(TelemPids); $p.Count -eq 1 -and $p[0] -ne $t0 -and -not (Alive $t0) } 15)
    $t1 = @(TelemPids) | Select-Object -First 1
    Check 'health stuck: same-name exe in another folder survived' (Alive $cp.Id)

    # 5. no restart loop: still stuck after the restart -> left alone
    Check 'health still stuck: logged "leaving it alone"' (Wait-Until { (THLog $dA 'leaving it alone until it has worked again') -ge 1 } 60)
    $ws2 = EvCount 'ws'; Start-Sleep 7
    Check 'health still stuck: checks continue (WebSocket probed)' ((EvCount 'ws') -gt $ws2)
    Check 'health still stuck: no second restart, same pid' ((THLog $dA 'telemetry server restarted') -eq 1 -and (@(TelemPids) -join ',') -eq "$t1")
    Set-Mode 'push busy'
    Check 'health recovers: "check: ok" logged' (Wait-Until { (THLog $dA 'telemetry server check: ok') -ge 1 } 30)
    Set-Mode 'silent busy'
    Check 'health: new stuck episode after a healthy check restarts again' (Wait-Until { (THLog $dA 'telemetry server restarted') -ge 2 } 60)
    Check 'health: second restart replaced the pid' (Wait-Until { $p = @(TelemPids); $p.Count -eq 1 -and $p[0] -ne $t1 -and -not (Alive $t1) } 15)
    $t2 = @(TelemPids) | Select-Object -First 1
    Check 'health: same-name exe in another folder survived the second restart' (Alive $cp.Id)

    # 8. no-process: the configured exe is closed while the game runs -> started again
    Set-Mode 'push busy'
    [void](Wait-Until { (THLog $dA 'telemetry server check: ok') -ge 2 } 30)
    $st = THLogRx $dA '\] telemetry server started \(pid'
    Stop-Pid $t2
    Check 'health no-process: configured exe started again' (Wait-Until { $p = @(TelemPids); $p.Count -eq 1 -and $p[0] -ne $t2 } 30)
    Check 'health no-process: through the normal start path (log)' ((THLogRx $dA '\] telemetry server started \(pid') -gt $st)
    Check 'health no-process: same-name exe in another folder untouched' (Alive $cp.Id)
    Stop-THWatcher $wA

    # 4. port dead: process runs, nothing listens on telemetryPort
    $cfgB = $thBase.Clone(); $cfgB.telemetryPort = $deadPort
    $t3 = @(TelemPids) | Select-Object -First 1
    $dB = New-THRun 'portdead' $cfgB
    $wB = Start-THWatcher $dB
    Check 'health port dead: restarted after 3 failed checks' (Wait-Until { (THLog $dB 'telemetry server restarted') -ge 1 } 60)
    Check 'health port dead: check 1/3, 2/3 with the port reason, then restarted' (THLogInOrder $dB @(
        'check 1/3: stuck: process runs but the port does not answer', 'check 2/3: stuck: process runs but the port does not answer', 'telemetry server restarted'))
    Check 'health port dead: old pid gone, new process runs' (Wait-Until { $p = @(TelemPids); $p.Count -eq 1 -and $p[0] -ne $t3 -and -not (Alive $t3) } 15)
    Check 'health port dead: same-name exe in another folder survived' (Alive $cp.Id)
    Stop-THWatcher $wB

    # 7a. -DryRun only logs the restart
    $t4 = @(TelemPids) | Select-Object -First 1
    $dC = New-THRun 'dryrun' $cfgB
    $wC = Start-THWatcher $dC '-DryRun'
    Check 'health DryRun: logs "DRY-RUN: would restart"' (Wait-Until { (THLog $dC 'DRY-RUN: would restart the telemetry server') -ge 1 } 60)
    Check 'health DryRun: nothing restarted, same pid' ((THLog $dC 'telemetry server restarted') -eq 0 -and (@(TelemPids) -join ',') -eq "$t4")
    Stop-THWatcher $wC

    # 7b. off by default: no startTelemetryServer / telemetryServerExe -> nothing started, checked or restarted
    @(TelemPids) | ForEach-Object { Stop-Pid $_ }
    [void](Wait-Until { @(TelemPids).Count -eq 0 } 10)
    Set-Mode 'silent busy'   # would count as stuck if anything checked
    $dD = New-THRun 'off' @{ telemetryHealthIntervalSec = 1; telemetryHealthFailures = 1; telemetryPort = $tPort; telemetryPipe = $tPipe }
    $ac2 = EvCount 'accept'
    $wD = Start-THWatcher $dD
    Check 'health off: game start evaluated ("not enabled in config")' (Wait-Until { (THLog $dD 'telemetry server: not enabled in config') -ge 1 } 30)
    Start-Sleep 6
    Check 'health off: telemetry exe not started' (@(TelemPids).Count -eq 0)
    Check 'health off: no check / restart logged' ((THLog $dD 'telemetry server check') -eq 0 -and (THLog $dD 'restart') -eq 0)
    Check 'health off: telemetry port never probed' ((EvCount 'accept') -eq $ac2)
    Stop-THWatcher $wD
    Check 'health: same-name exe in another folder still alive at the end' (Alive $cp.Id)
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
