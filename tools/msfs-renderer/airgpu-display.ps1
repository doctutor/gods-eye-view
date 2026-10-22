# Personal fork: the resolution levers on an AirGPU machine, found out
# rather than assumed. Read-only unless -Set is given. See README.md,
# "Resolution". Not part of upstream God's Eye View.
#
#   powershell -ExecutionPolicy Bypass -File airgpu-display.ps1              (report)
#   powershell -ExecutionPolicy Bypass -File airgpu-display.ps1 -Set 3840x2160
#
# The report: the GPU and its memory, the primary display's current mode
# and every mode its driver offers (the virtual display behind AirGPU's
# stream decides which), and the video and graphics lines of MSFS 2024's
# UserCfg.opt (its own names for resolution, render scaling and the preset,
# which are not published). -Set changes the primary display to a mode the
# driver offers, and keeps it (the registry); it refuses any other. The
# sim's window and OBS's canvas follow the display: run airgpu-setup.ps1
# again afterwards (or pass it -ObsCanvas).

param(
  [string]$Set = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class GevDisplay
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE devMode);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE devMode, IntPtr hwnd, int flags, IntPtr param);

    const int ENUM_CURRENT_SETTINGS = -1;
    const int DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000, DM_DISPLAYFREQUENCY = 0x400000;
    const int CDS_UPDATEREGISTRY = 0x01, CDS_TEST = 0x02;

    static DEVMODE Blank()
    {
        var m = new DEVMODE();
        m.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        return m;
    }

    /// <summary>The current mode: width, height, refresh rate.</summary>
    public static int[] Current()
    {
        var m = Blank();
        if (!EnumDisplaySettings(null, ENUM_CURRENT_SETTINGS, ref m)) return new int[0];
        return new[] { m.dmPelsWidth, m.dmPelsHeight, m.dmDisplayFrequency };
    }

    /// <summary>Every mode the driver offers, as "WxH@Hz", without repeats.</summary>
    public static List<string> Modes()
    {
        var seen = new List<string>();
        var m = Blank();
        for (int i = 0; EnumDisplaySettings(null, i, ref m); i++)
        {
            var mode = m.dmPelsWidth + "x" + m.dmPelsHeight + "@" + m.dmDisplayFrequency;
            if (!seen.Contains(mode)) seen.Add(mode);
            m = Blank();
        }
        return seen;
    }

    /// <summary>Change to a mode (the highest refresh rate offered for it); 0 on success, else the DISP_CHANGE code.</summary>
    public static int Change(int width, int height, int hz)
    {
        var m = Blank();
        m.dmPelsWidth = width;
        m.dmPelsHeight = height;
        m.dmDisplayFrequency = hz;
        m.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;
        int test = ChangeDisplaySettingsEx(null, ref m, IntPtr.Zero, CDS_TEST, IntPtr.Zero);
        if (test != 0) return test;
        return ChangeDisplaySettingsEx(null, ref m, IntPtr.Zero, CDS_UPDATEREGISTRY, IntPtr.Zero);
    }
}
'@

function Show-Report() {
  Write-Output 'GPU:'
  $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if ($smi) { & $smi.Source --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader | ForEach-Object { "  $_" } }
  else { Get-CimInstance Win32_VideoController | ForEach-Object { "  $($_.Name)" } }

  $current = [GevDisplay]::Current()
  $modes = [GevDisplay]::Modes()
  Write-Output "Primary display: $($current[0])x$($current[1]) at $($current[2]) Hz"
  $sizes = $modes | ForEach-Object { ($_ -split '@')[0] } | Select-Object -Unique |
    Sort-Object { [int](($_ -split 'x')[0]) * [int](($_ -split 'x')[1]) } -Descending
  Write-Output "Modes the driver offers ($(@($sizes).Count)), largest first: $((@($sizes) | Select-Object -First 12) -join ', ')"
  Write-Output "  3840x2160 offered: $(if (@($sizes) -contains '3840x2160') { 'yes' } else { 'no' })"

  $cfg = Join-Path $Env:APPDATA 'Microsoft Flight Simulator 2024\UserCfg.opt'
  if (Test-Path -LiteralPath $cfg) {
    Write-Output "MSFS 2024's $($cfg), its video and graphics lines:"
    Select-String -LiteralPath $cfg -Pattern 'Resolution|Render|Scal|Preset|Windowed|FullScreen|Upscal|DLSS|FSR|Frame|VSync|Sharpen|Quality' |
      ForEach-Object { "  $($_.LineNumber): $($_.Line.Trim())" }
  } else {
    Write-Output "No $($cfg) yet: start the sim once and change one graphics setting."
  }
}

if ($Set) {
  if ($Set -notmatch '^(\d{3,5})x(\d{3,5})$') { Write-Output "-Set takes WIDTHxHEIGHT, not $Set"; exit 2 }
  $width = [int]$Matches[1]; $height = [int]$Matches[2]
  $rates = [GevDisplay]::Modes() | Where-Object { ($_ -split '@')[0] -eq "$($width)x$($height)" } |
    ForEach-Object { [int](($_ -split '@')[1]) } | Sort-Object -Descending
  if (-not $rates) {
    Write-Output "$($width)x$($height) is not a mode this display's driver offers; nothing changed."
    Write-Output 'The virtual display behind the stream decides: ask for that resolution in the streaming client (Moonlight), then run this again.'
    Show-Report
    exit 1
  }
  $code = [GevDisplay]::Change($width, $height, $rates[0])
  if ($code -ne 0) { Write-Output "Windows refused $($width)x$($height) at $($rates[0]) Hz (DISP_CHANGE $code); nothing changed."; exit 1 }
  Write-Output "Primary display now $($width)x$($height) at $($rates[0]) Hz. Run airgpu-setup.ps1 again so OBS's canvas follows."
}
Show-Report
