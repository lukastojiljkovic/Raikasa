#Requires -Version 7.2
# SPDX-License-Identifier: MIT
<#
.SYNOPSIS
    Runner-proof probe for the desktop token: creates a small window, proves it had a
    window handle on this desktop, and closes it.

.DESCRIPTION
    Calls CreateWindowExW (a 200 by 100 "STATIC" window), checks the handle with IsWindow
    and GetWindowThreadProcessId (the window belongs to this process), shows it without
    activating it, then destroys it and checks that the handle is gone. A process whose
    token has no access to the window station and desktop fails here, or never starts.
    Writes window.json to $env:STANDARD_USER_OUT and prints it. Exit 0 when the window
    existed and was destroyed; 1 when it could not be made; 2 without STANDARD_USER_OUT.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $env:STANDARD_USER_OUT) {
    [Console]::Error.WriteLine('STANDARD_USER_OUT is not set: run this probe through the standard-user action.')
    exit 2
}

if (-not ('WindowProbeNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class WindowProbeNative {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWindowExW(int exStyle, string className, string windowName, uint style, int x, int y,
                                         int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    const uint WS_OVERLAPPEDWINDOW = 0x00CF0000;

    public static IntPtr Create() {
        IntPtr window = CreateWindowExW(0, "STATIC", "standard-user window probe", WS_OVERLAPPEDWINDOW, 0, 0, 200, 100,
                                        IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (window == IntPtr.Zero) throw new Win32Exception();
        return window;
    }

    public static uint Owner(IntPtr window) { uint processId; GetWindowThreadProcessId(window, out processId); return processId; }
}
'@
}

$result = [ordered]@{ handle = 0; wasWindow = $false; ownedByThisProcess = $false; visible = $false; destroyed = $false; error = $null }
$window = [IntPtr]::Zero
try {
    $window = [WindowProbeNative]::Create()
    $result.handle = $window.ToInt64()
    $result.wasWindow = [WindowProbeNative]::IsWindow($window)
    $result.ownedByThisProcess = ([WindowProbeNative]::Owner($window) -eq [uint32] $PID)
    $null = [WindowProbeNative]::ShowWindow($window, 4) # SW_SHOWNOACTIVATE
    $result.visible = [WindowProbeNative]::IsWindowVisible($window)
} catch {
    $result.error = $_.Exception.Message
} finally {
    if ($window -ne [IntPtr]::Zero) {
        $null = [WindowProbeNative]::DestroyWindow($window)
        $result.destroyed = -not [WindowProbeNative]::IsWindow($window)
    }
}

$json = $result | ConvertTo-Json
$json | Set-Content -LiteralPath (Join-Path $env:STANDARD_USER_OUT 'window.json') -Encoding utf8
$json
if ($result.handle -ne 0 -and $result.wasWindow -and $result.ownedByThisProcess -and $result.destroyed) { exit 0 }
exit 1
