# Drives a genuine OS-level drag over the running Jotter window.
#
# CDP's drag interception can start a drag but cannot prove the drop lands: in
# that mode Chromium never performs a real drop, the client is meant to emulate
# one, and the emulation is not the code path a user's mouse takes. This is.
#
#   powershell -File scripts/real-drag.ps1 -FromX 479 -FromY 1425 -ToX 864 -ToY 1415
#
# It moves the physical cursor for about a second and puts it back.

param(
  [Parameter(Mandatory = $true)][int]$FromX,
  [Parameter(Mandatory = $true)][int]$FromY,
  [Parameter(Mandatory = $true)][int]$ToX,
  [Parameter(Mandatory = $true)][int]$ToY,
  [int]$Steps = 26
)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Rat {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP   = 0x0004;
}
'@

$origin = New-Object Rat+POINT
[void][Rat]::GetCursorPos([ref]$origin)

$hwnd = (Get-Process jotter -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
if ($null -eq $hwnd -or $hwnd -eq 0) { Write-Output "no jotter window"; exit 1 }
[void][Rat]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 400

[void][Rat]::SetCursorPos($FromX, $FromY)
Start-Sleep -Milliseconds 160
[Rat]::mouse_event([Rat]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 120

# The first few pixels are what trip the drag threshold; after that the OS drag
# loop is running and every move has to be delivered to it one at a time.
for ($i = 1; $i -le $Steps; $i++) {
  $x = [int]($FromX + ($ToX - $FromX) * $i / $Steps)
  $y = [int]($FromY + ($ToY - $FromY) * $i / $Steps)
  [void][Rat]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 35
}

Start-Sleep -Milliseconds 220
[Rat]::mouse_event([Rat]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 400

[void][Rat]::SetCursorPos($origin.X, $origin.Y)
Write-Output "dragged ($FromX,$FromY) -> ($ToX,$ToY)"
