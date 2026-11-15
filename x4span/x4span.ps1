<#
.SYNOPSIS
  x4span - X4 ablak kiterjesztese tobb monitorra (keret nelkuli ablak + pozicio/meret), es visszaallitas.

.DESCRIPTION
  Csak dokumentalt Win32 hivasokat hasznal (Add-Type): EnumDisplayMonitors, GetMonitorInfoW,
  EnumDisplayDevicesW, GetWindowLongPtrW/SetWindowLongPtrW, SetWindowPos, GetWindowRect,
  GetClientRect, ClientToScreen, ShowWindow, IsIconic, IsZoomed, SetProcessDpiAwarenessContext.
  A jatek config.xml-jet csak OLVASSA (figyelmeztet, ha a res_width/res_height nem egyezik az ablakkal).
  Kijelzo-, NVIDIA- vagy jatekbeallitast NEM valtoztat.

.EXAMPLE
  .\x4span.ps1 -List
  .\x4span.ps1 -Preset k2-triple -WhatIf
  .\x4span.ps1 -Preset k2-triple -WhatIf -Simulate dell-uw-laptop
  .\x4span.ps1 -Preset k2-triple            # a futo X4 ablakra
  .\x4span.ps1 -Restore                     # visszaallitas a mentett allapotra
  .\x4span.ps1 -Preset k1-uw-left -Handle 0x1234 -NoActivate -ZBottom   # tesztablakra
#>
[CmdletBinding()]
param(
  [string]$Preset,
  [switch]$List,
  [switch]$WhatIf,
  [switch]$Restore,
  [ValidateSet('none', 'dell-uw-laptop', 'laptop-uw-dell', 'uw-1080')]
  [string]$Simulate = 'none',
  [string]$ProcessName = 'X4',
  [string]$Handle,
  [string]$ConfigPath = 'D:\X4-userdata\6144\config.xml',
  [string]$StateDir = '',
  [switch]$NoActivate,
  [switch]$ZBottom,
  [switch]$Popup,
  [string]$Area,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 + "powershell -File": $PSScriptRoot is empty in param defaults, so compute it here.
if (-not $StateDir) {
  $scriptPath = $MyInvocation.MyCommand.Path
  if (-not $scriptPath) { $scriptPath = $PSCommandPath }
  $StateDir = Join-Path (Split-Path -Parent $scriptPath) 'state'
}

# Short preset aliases for x4span.cmd (K1 -> k1-uw-left, ...).
$PresetAlias = @{ 'k1' = 'k1-uw-left'; 'k2' = 'k2-triple'; 'k3' = 'k3-triple-1080'; 'k4' = 'k4-surround'; 'k6' = 'k6-virtual'; 'uw' = 'single-uw' }
if ($Preset -and $PresetAlias.ContainsKey($Preset.ToLower())) { $Preset = $PresetAlias[$Preset.ToLower()] }

if (-not ('X4Span.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace X4Span {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE { public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey; }
  public class Mon { public string Device; public int X, Y, W, H; public bool Primary; public string Interface; }
  public static class Native {
    delegate bool MonitorEnumProc(IntPtr hMon, IntPtr hdc, IntPtr lprc, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr hMon, ref MONITORINFOEX mi);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplayDevicesW(string dev, uint i, ref DISPLAY_DEVICE dd, uint flags);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetWindowLongPtrW(IntPtr h, int idx);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowLongPtrW(IntPtr h, int idx, IntPtr v);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    public static List<Mon> Monitors() {
      var list = new List<Mon>();
      EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (h, dc, r, d) => {
        var mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        if (GetMonitorInfoW(h, ref mi)) {
          var m = new Mon { Device = mi.szDevice, X = mi.rcMonitor.Left, Y = mi.rcMonitor.Top,
            W = mi.rcMonitor.Right - mi.rcMonitor.Left, H = mi.rcMonitor.Bottom - mi.rcMonitor.Top,
            Primary = (mi.dwFlags & 1) != 0 };
          var dd = new DISPLAY_DEVICE(); dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
          if (EnumDisplayDevicesW(mi.szDevice, 0, ref dd, 1)) m.Interface = dd.DeviceID; // EDD_GET_DEVICE_INTERFACE_NAME
          list.Add(m);
        }
        return true; }, IntPtr.Zero);
      return list;
    }
  }
}
'@
}

# Physical pixel coordinates even if Windows scaling is not 100% (PER_MONITOR_AWARE_V2 = -4).
try { [void][X4Span.Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }

$GWL_STYLE = -16; $GWL_EXSTYLE = -20
$STYLE_STRIP = 0x00C00000 -bor 0x00040000 -bor 0x00080000 -bor 0x00020000 -bor 0x00010000   # CAPTION|THICKFRAME|SYSMENU|MIN|MAX
$EXSTYLE_STRIP = 0x00000001 -bor 0x00000100 -bor 0x00000200 -bor 0x00020000                  # DLGMODALFRAME|WINDOWEDGE|CLIENTEDGE|STATICEDGE
$SWP_NOZORDER = 0x0004; $SWP_NOACTIVATE = 0x0010; $SWP_FRAMECHANGED = 0x0020; $SWP_NOOWNERZORDER = 0x0200
$HWND_BOTTOM = [IntPtr]1
$BASE_PIXELS = 3440 * 1440   # mai allapot: 3440x1440 egy monitoron

# ---------------------------------------------------------------- monitors
function Get-EdidMm([string]$iface) {
  # \\?\DISPLAY#DELD05F#5&acf3954&2&UID4352#{guid}  ->  HKLM\...\Enum\DISPLAY\DELD05F\5&acf3954&2&UID4352
  if (-not $iface) { return $null }
  $parts = $iface -split '#'
  if ($parts.Count -lt 3) { return $null }
  $key = "HKLM:\SYSTEM\CurrentControlSet\Enum\DISPLAY\$($parts[1])\$($parts[2])\Device Parameters"
  try { $e = [byte[]](Get-ItemProperty -Path $key -Name EDID -ErrorAction Stop).EDID } catch { return $null }
  if (-not $e -or $e.Length -lt 128) { return $null }
  $b = 54
  $ha = [int]$e[$b + 2] + (([int]$e[$b + 4] -shr 4) * 256)
  $va = [int]$e[$b + 5] + (([int]$e[$b + 7] -shr 4) * 256)
  $hmm = [int]$e[$b + 12] + (([int]$e[$b + 14] -shr 4) * 256)
  $vmm = [int]$e[$b + 13] + (([int]$e[$b + 14] -band 15) * 256)
  return [pscustomobject]@{ Code = $parts[1]; NativeW = $ha; NativeH = $va; WidthMm = $hmm; HeightMm = $vmm }
}

function Get-Monitors {
  $out = @()
  foreach ($m in [X4Span.Native]::Monitors()) {
    $edid = Get-EdidMm $m.Interface
    $code = if ($edid) { $edid.Code } else { '?' }
    $role = switch -Regex ($code) { '^AUS3438$' { 'uw' } '^DELD05F$' { 'dell' } '^NCP004D$' { 'laptop' } default { 'other' } }
    if ($role -eq 'other' -and $m.H -gt 0 -and ($m.W / $m.H) -gt 2.2 -and $m.W -lt 5000) { $role = 'uw' }
    $mmW = if ($edid) { $edid.WidthMm } else { 0 }
    $mmH = if ($edid) { $edid.HeightMm } else { 0 }
    $out += [pscustomobject]@{
      Role = $role; Code = $code; Device = $m.Device; Primary = $m.Primary
      X = $m.X; Y = $m.Y; W = $m.W; H = $m.H
      WidthMm = $mmW; HeightMm = $mmH
      PitchMm = if ($mmW -gt 0) { [math]::Round($mmW / $m.W, 4) } else { 0 }   # mm per CURRENT-mode pixel
    }
  }
  return $out
}

function Get-SimulatedMonitors($mons, [string]$mode) {
  # Fizikai monitorok athelyezese "papiron" (a Windows elrendezest NEM valtoztatja).
  $uw = $mons | Where-Object Role -eq 'uw' | Select-Object -First 1
  $dell = $mons | Where-Object Role -eq 'dell' | Select-Object -First 1
  $lap = $mons | Where-Object Role -eq 'laptop' | Select-Object -First 1
  if (-not $uw) { throw 'Nincs ultrawide monitor a listaban.' }
  $u = $uw.PSObject.Copy()
  if ($mode -eq 'uw-1080') { $u.W = 2560; $u.H = 1080; $u.PitchMm = [math]::Round($u.WidthMm / 2560, 4) }
  $u.X = 0; $u.Y = 0
  $res = @($u)
  $left = $dell; $right = $lap
  if ($mode -eq 'laptop-uw-dell') { $left = $lap; $right = $dell }
  if ($left) { $l = $left.PSObject.Copy(); $l.X = -$l.W; $l.Y = [int](($u.H - $l.H) / 2); $res += $l }
  if ($right) { $r = $right.PSObject.Copy(); $r.X = $u.W; $r.Y = [int](($u.H - $r.H) / 2); $res += $r }
  return $res
}

function Get-Neighbour($mons, $uw, [string]$side) {
  foreach ($m in $mons) {
    if ($m.Device -eq $uw.Device) { continue }
    $vOverlap = ([math]::Min($m.Y + $m.H, $uw.Y + $uw.H) - [math]::Max($m.Y, $uw.Y)) -gt 0
    if (-not $vOverlap) { continue }
    if ($side -eq 'left' -and ($m.X + $m.W) -eq $uw.X) { return $m }
    if ($side -eq 'right' -and $m.X -eq ($uw.X + $uw.W)) { return $m }
  }
  return $null
}

# ---------------------------------------------------------------- presets
$PresetInfo = [ordered]@{
  'single-uw'      = 'Alap: keret nelkuli ablak csak az ultrawide-on (A/B osszehasonlitashoz).'
  'k1-uw-left'     = 'K1: ultrawide kozepen, bal szomszed (Dell) periferia, jobb oldalt ugyanannyi kepen kivul.'
  'k2-triple'      = 'K2: bal szomszed + ultrawide (nativ 1440) + jobb szomszed, oldalak fuggolegesen kozepen.'
  'k3-triple-1080' = 'K3: mint K2, de az ultrawide 2560x1080 egyedi felbontason (mindharom 1080 sor).'
  'k4-surround'    = 'K4: NVIDIA Surround - a Surround-kijelzo teljes terulete (ha aktiv).'
  'k6-virtual'     = 'K6: virtualis szeles monitor (IddCx) teljes terulete (ha telepitve van).'
  'custom'         = 'Sajat teglalap: -Area "x,y,w,h" (pl. kiserletekhez).'
}

function Get-PresetRect([string]$name, $mons) {
  $uw = $mons | Where-Object Role -eq 'uw' | Select-Object -First 1
  $warn = @()
  switch ($name) {
    'single-uw' {
      if (-not $uw) { throw 'Nincs ultrawide.' }
      return @{ X = $uw.X; Y = $uw.Y; W = $uw.W; H = $uw.H; Warn = $warn; Uw = $uw }
    }
    'k1-uw-left' {
      $l = Get-Neighbour $mons $uw 'left'
      if (-not $l) { throw 'K1: az ultrawide-tol balra nincs szomszedos monitor.' }
      $r = Get-Neighbour $mons $uw 'right'
      if ($r) { $warn += "Jobbra is van monitor ($($r.Role)) - erre a K2 valo." }
      $warn += "A jobb oldali $($l.W) px kepen kivulre kerul (renderelve, de nem latszik)."
      $ideal = $uw.Y + [int](($uw.H - $l.H) / 2)
      if ($l.Y -ne $ideal) { $warn += "$($l.Role): Y=$($l.Y), kozepre igazitva $ideal lenne (elteres $($l.Y - $ideal) px) - a horizont ennyivel csuszik el rajta." }
      return @{ X = $uw.X - $l.W; Y = $uw.Y; W = $uw.W + 2 * $l.W; H = $uw.H; Warn = $warn; Uw = $uw }
    }
    { $_ -in 'k2-triple', 'k3-triple-1080' } {
      $l = Get-Neighbour $mons $uw 'left'; $r = Get-Neighbour $mons $uw 'right'
      if (-not $l -or -not $r) {
        throw "${name}: az ultrawide-nak mindket oldalon szomszed kell (most: bal=$([bool]$l), jobb=$([bool]$r)). Rendezd at a Windows Kijelzo beallitasokban, vagy probald: -Simulate dell-uw-laptop"
      }
      if ($name -eq 'k3-triple-1080' -and $uw.H -ne 1080) { $warn += "Az ultrawide most $($uw.W)x$($uw.H) - a K3-hoz 2560x1080 kell (NVIDIA egyedi felbontas, GPU-s meretezes)." }
      if ($name -eq 'k2-triple' -and $uw.H -eq 1080) { $warn += 'Az ultrawide 1080 soros modban van - ez a K3 esete.' }
      foreach ($s in @($l, $r)) {
        $ideal = $uw.Y + [int](($uw.H - $s.H) / 2)
        if ($s.Y -ne $ideal) { $warn += "$($s.Role): Y=$($s.Y), kozepre igazitva $ideal lenne (elteres $($s.Y - $ideal) px) - a horizont ennyivel csuszik el rajta." }
      }
      return @{ X = $l.X; Y = $uw.Y; W = ($r.X + $r.W) - $l.X; H = $uw.H; Warn = $warn; Uw = $uw }
    }
    'k4-surround' {
      $s = $mons | Where-Object { $_.W -ge 5000 } | Select-Object -First 1
      if (-not $s) { throw 'K4: nincs >=5000 px szeles (Surround) kijelzo - a Surround nincs bekapcsolva.' }
      return @{ X = $s.X; Y = $s.Y; W = $s.W; H = $s.H; Warn = $warn; Uw = $s }
    }
    'k6-virtual' {
      $s = $mons | Where-Object { $_.Role -eq 'other' -and $_.W -ge 5000 } | Select-Object -First 1
      if (-not $s) { throw 'K6: nincs virtualis szeles monitor (>=5000 px, ismeretlen EDID).' }
      $warn += 'A virtualis monitor kepet egy kulon kompozitor viszi a valodi monitorokra (lasd design-route-de.md).'
      return @{ X = $s.X; Y = $s.Y; W = $s.W; H = $s.H; Warn = $warn; Uw = $s }
    }
    'custom' {
      if (-not $Area) { throw 'custom: -Area "x,y,w,h" kell.' }
      $v = $Area -split ',' | ForEach-Object { [int]$_.Trim() }
      if ($uw) { $ref = $uw } else { $ref = $mons | Select-Object -First 1 }
      return @{ X = $v[0]; Y = $v[1]; W = $v[2]; H = $v[3]; Warn = $warn; Uw = $ref }
    }
    default { throw "Ismeretlen preset: $name. Lehetsegesek: $($PresetInfo.Keys -join ', ')" }
  }
}

function Show-Analysis($name, $rect, $mons) {
  $uw = $rect.Uw
  $mp = $rect.W * $rect.H
  $cx = $rect.X + $rect.W / 2; $cy = $rect.Y + $rect.H / 2
  $uwcx = $uw.X + $uw.W / 2; $uwcy = $uw.Y + $uw.H / 2
  "== $name : $($PresetInfo[$name])"
  "   ablak: x=$($rect.X) y=$($rect.Y) w=$($rect.W) h=$($rect.H)   (keparany {0:N3}:1)" -f ($rect.W / $rect.H)
  "   kepponttom: {0:N2} MP = {1:N2}x a mai 3440x1440-hez kepest" -f ($mp / 1e6), ($mp / $BASE_PIXELS)
  "   celkereszt (ablakkozep): ({0},{1}) - az ultrawide kozepetol dx={2} dy={3} px" -f $cx, $cy, ($cx - $uwcx), ($cy - $uwcy)
  $visible = 0
  foreach ($m in $mons) {
    $ix = [math]::Max($rect.X, $m.X); $iy = [math]::Max($rect.Y, $m.Y)
    $ax = [math]::Min($rect.X + $rect.W, $m.X + $m.W); $ay = [math]::Min($rect.Y + $rect.H, $m.Y + $m.H)
    if ($ax -le $ix -or $ay -le $iy) { continue }
    $vw = $ax - $ix; $vh = $ay - $iy; $visible += $vw * $vh
    $ratio = if ($uw.PitchMm -gt 0 -and $m.PitchMm -gt 0) { '{0:N3}x' -f ($m.PitchMm / $uw.PitchMm) } else { 'n/a' }
    "   - {0,-6} {1}: ablak-sorok {2}..{3}, oszlopok {4}..{5} ({6}x{7}); kepmeret a kozephez kepest {8} ({9} mm/px)" -f $m.Role, $m.Device, ($iy - $rect.Y), ($ay - $rect.Y - 1), ($ix - $rect.X), ($ax - $rect.X - 1), $vw, $vh, $ratio, $m.PitchMm
  }
  "   lathato: {0:N2} MP, renderelt de nem lathato: {1:N2} MP ({2:N0}%)" -f ($visible / 1e6), (($mp - $visible) / 1e6), (100 * ($mp - $visible) / $mp)
  "   config.xml (kezzel, jatek LEZARVA): fullscreen=false, borderless=false, res_width=$($rect.W), res_height=$($rect.H)  (reszletek: presets.md)"
  foreach ($w in $rect.Warn) { "   ! $w" }
}

# ---------------------------------------------------------------- window
function Resolve-Window {
  if ($Handle) {
    if ($Handle -match '^0x') { $h = [IntPtr]([Convert]::ToInt64($Handle.Substring(2), 16)) } else { $h = [IntPtr]([int64]$Handle) }
  } else {
    $p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
    if (-not $p) { throw "Nem talalok futo '$ProcessName' ablakot." }
    $h = $p.MainWindowHandle
  }
  if (-not [X4Span.Native]::IsWindow($h)) { throw "Ervenytelen ablak: $h" }
  return $h
}

function Get-WinInfo([IntPtr]$h) {
  $r = New-Object X4Span.RECT; $c = New-Object X4Span.RECT; $pt = New-Object X4Span.POINT
  [void][X4Span.Native]::GetWindowRect($h, [ref]$r); [void][X4Span.Native]::GetClientRect($h, [ref]$c)
  [void][X4Span.Native]::ClientToScreen($h, [ref]$pt)
  [pscustomobject]@{
    Style = [int64][X4Span.Native]::GetWindowLongPtrW($h, $GWL_STYLE)
    ExStyle = [int64][X4Span.Native]::GetWindowLongPtrW($h, $GWL_EXSTYLE)
    X = $r.Left; Y = $r.Top; W = $r.Right - $r.Left; H = $r.Bottom - $r.Top
    ClientX = $pt.X; ClientY = $pt.Y; ClientW = $c.Right; ClientH = $c.Bottom
    Iconic = [X4Span.Native]::IsIconic($h); Zoomed = [X4Span.Native]::IsZoomed($h)
  }
}

function Read-ConfigRes {
  if (-not (Test-Path $ConfigPath)) { return $null }
  try {
    [xml]$x = Get-Content -Path $ConfigPath -Raw
    return [pscustomobject]@{ W = [int]$x.root.res_width; H = [int]$x.root.res_height; Full = $x.root.fullscreen; Borderless = $x.root.borderless }
  } catch { return $null }
}

function Get-StatePath([IntPtr]$h) { Join-Path $StateDir ("window-{0}.json" -f [int64]$h) }

# ---------------------------------------------------------------- main
$mons = Get-Monitors
if ($Simulate -ne 'none') {
  $mons = Get-SimulatedMonitors $mons $Simulate
  "(SZIMULACIO: '$Simulate' elrendezes papiron - a Windows beallitas nem valtozik; ablakot nem mozgatok)"
  $WhatIf = $true
}

if ($List -or (-not $Preset -and -not $Restore)) {
  'Monitorok (fizikai kepponttal):'
  foreach ($m in $mons | Sort-Object X) {
    "  {0,-6} {1,-8} {2,-12} x={3,6} y={4,5} {5}x{6} {7}x{8} mm  {9} mm/px{10}" -f $m.Role, $m.Code, $m.Device, $m.X, $m.Y, $m.W, $m.H, $m.WidthMm, $m.HeightMm, $m.PitchMm, $(if ($m.Primary) { '  (elsodleges)' } else { '' })
  }
  ''
  'Presetek:'
  foreach ($k in $PresetInfo.Keys) { "  {0,-15} {1}" -f $k, $PresetInfo[$k] }
  if (-not $Preset) { return }
}

if ($Restore) {
  $h = Resolve-Window
  $sp = Get-StatePath $h
  if (-not (Test-Path $sp)) { throw "Nincs mentett allapot ehhez az ablakhoz: $sp" }
  $s = Get-Content $sp -Raw | ConvertFrom-Json
  if ($WhatIf) { "WhatIf: visszaallitanam: style=0x{0:X} ex=0x{1:X} rect=({2},{3}) {4}x{5}" -f $s.Style, $s.ExStyle, $s.X, $s.Y, $s.W, $s.H; return }
  [void][X4Span.Native]::SetWindowLongPtrW($h, $GWL_STYLE, [IntPtr][int64]$s.Style)
  [void][X4Span.Native]::SetWindowLongPtrW($h, $GWL_EXSTYLE, [IntPtr][int64]$s.ExStyle)
  $flags = $SWP_FRAMECHANGED -bor $SWP_NOOWNERZORDER -bor $SWP_NOZORDER
  if ($NoActivate) { $flags = $flags -bor $SWP_NOACTIVATE }
  if (-not [X4Span.Native]::SetWindowPos($h, [IntPtr]::Zero, [int]$s.X, [int]$s.Y, [int]$s.W, [int]$s.H, $flags)) { throw "SetWindowPos hiba: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $now = Get-WinInfo $h
  "Visszaallitva: rect=({0},{1}) {2}x{3}, kliens {4}x{5}, style=0x{6:X}" -f $now.X, $now.Y, $now.W, $now.H, $now.ClientW, $now.ClientH, $now.Style
  Remove-Item $sp
  return
}

$rect = Get-PresetRect $Preset $mons
Show-Analysis $Preset $rect $mons

$cfg = Read-ConfigRes
if ($cfg) {
  "   config.xml most: fullscreen=$($cfg.Full) borderless=$($cfg.Borderless) res=$($cfg.W)x$($cfg.H)"
  if ($cfg.W -ne $rect.W -or $cfg.H -ne $rect.H) { "   ! A jatek felbontasa ($($cfg.W)x$($cfg.H)) nem egyezik az ablakkal ($($rect.W)x$($rect.H)) - a kep atmeretezodik vagy a jatek ujraepiti a swapchaint (nem ellenorzott)." }
  if ($cfg.Full -eq 'true' -and $cfg.Borderless -ne 'true') { '   ! A jatek most exkluziv teljes kepernyon fut: atmeretezni csak Windowed (ablakos) modban van ertelme.' }
}

if ($WhatIf) { ''; 'WhatIf: semmit nem valtoztattam.'; return }

$h = Resolve-Window
$before = Get-WinInfo $h
if ($before.Iconic -and -not $Force) { throw 'Az ablak le van kicsinyitve. Allitsd vissza (vagy -Force: SW_RESTORE).' }
if ($before.Iconic -or $before.Zoomed) { [void][X4Span.Native]::ShowWindow($h, 9) ; $before = Get-WinInfo $h }  # SW_RESTORE

if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir | Out-Null }
$sp = Get-StatePath $h
if (-not (Test-Path $sp)) { $before | ConvertTo-Json | Set-Content -Path $sp -Encoding utf8 }   # az ELSO eredeti allapot marad meg

$newStyle = $before.Style -band (-bnot [int64]$STYLE_STRIP)
# Mert ertek (2026-11-14): WS_POPUP nelkul a Windows ~a virtualis asztal + keret meretere vagja az ablakot (7300x1460);
# WS_POPUP-pal 16384x2160 is atment. Nagyobb-mint-az-asztal ablakhoz ezert WS_POPUP kell.
$vx = ($mons | ForEach-Object { $_.X } | Measure-Object -Minimum).Minimum; $vr = ($mons | ForEach-Object { $_.X + $_.W } | Measure-Object -Maximum).Maximum
$vy = ($mons | ForEach-Object { $_.Y } | Measure-Object -Minimum).Minimum; $vb = ($mons | ForEach-Object { $_.Y + $_.H } | Measure-Object -Maximum).Maximum
if (-not $Popup -and ($rect.W -gt ($vr - $vx) -or $rect.H -gt ($vb - $vy))) { $Popup = $true; '(Az ablak nagyobb a virtualis asztalnal -> WS_POPUP stilus is kell, bekapcsolom.)' }
if ($Popup) { $newStyle = $newStyle -bor [int64]0x80000000 }
$newEx = $before.ExStyle -band (-bnot [int64]$EXSTYLE_STRIP)
[void][X4Span.Native]::SetWindowLongPtrW($h, $GWL_STYLE, [IntPtr]$newStyle)
[void][X4Span.Native]::SetWindowLongPtrW($h, $GWL_EXSTYLE, [IntPtr]$newEx)
$flags = $SWP_FRAMECHANGED -bor $SWP_NOOWNERZORDER
$after = [IntPtr]::Zero
if ($ZBottom) { $after = $HWND_BOTTOM } else { $flags = $flags -bor $SWP_NOZORDER }
if ($NoActivate) { $flags = $flags -bor $SWP_NOACTIVATE }
if (-not [X4Span.Native]::SetWindowPos($h, $after, $rect.X, $rect.Y, $rect.W, $rect.H, $flags)) { throw "SetWindowPos hiba: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

$now = Get-WinInfo $h
''
"Alkalmazva. Kert: ({0},{1}) {2}x{3}  |  kapott ablak: ({4},{5}) {6}x{7}  |  kliens: ({8},{9}) {10}x{11}  |  style 0x{12:X} -> 0x{13:X}" -f $rect.X, $rect.Y, $rect.W, $rect.H, $now.X, $now.Y, $now.W, $now.H, $now.ClientX, $now.ClientY, $now.ClientW, $now.ClientH, $before.Style, $now.Style
if ($now.ClientW -ne $rect.W -or $now.ClientH -ne $rect.H -or $now.ClientX -ne $rect.X -or $now.ClientY -ne $rect.Y) { '! A kliensterulet NEM pontosan a kert teglalap (a Windows vagy az alkalmazas korlatozta).' } else { 'OK: a kliensterulet pontosan a kert teglalap.' }
"Visszaallitas: .\x4span.ps1 -Restore$(if ($Handle) { " -Handle $Handle" })   (mentett allapot: $sp)"


