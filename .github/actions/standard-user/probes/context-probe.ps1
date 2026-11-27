#Requires -Version 7.2
# SPDX-License-Identifier: MIT
<#
.SYNOPSIS
    Runner-proof probe: records the token, the window station and the workspace access of
    the user it runs as.

.DESCRIPTION
    Writes to $env:STANDARD_USER_OUT:
      probe-groups.csv  the output of `whoami /groups /fo csv /nh`. It has a name of its
                        own because groups.csv in the same folder is the wrapper's record of
                        the token, which the action's check reads after the child ends; no
                        probe writes that file or user.csv (a Pester test checks it);
      context.json      the user SID, the integrity label (SID and name), whether
                        INTERACTIVE (S-1-5-4) and BATCH (S-1-5-3) are in the token, the
                        window station's name and whether it is visible (WSF_VISIBLE, from
                        GetUserObjectInformationW with UOI_FLAGS), the profile and TEMP
                        folders the logon gave the child, and whether a new file can be
                        made in $env:GITHUB_WORKSPACE (allowed, denied, or the error; the
                        file is made with CreateNew and deleted again).
    It prints context.json too, so the action's log shows it. Exit 0 once both files are
    written; 2 when STANDARD_USER_OUT is not set. It judges nothing: the action's context
    check does, and the runner proof reads the workspace result.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $env:STANDARD_USER_OUT) {
    [Console]::Error.WriteLine('STANDARD_USER_OUT is not set: run this probe through the standard-user action.')
    exit 2
}

if (-not ('ContextProbeNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ContextProbeNative {
    [StructLayout(LayoutKind.Sequential)]
    struct USEROBJECTFLAGS { public int fInherit; public int fReserved; public uint dwFlags; }
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true, EntryPoint = "GetUserObjectInformationW")]
    static extern bool GetFlags(IntPtr obj, int index, ref USEROBJECTFLAGS info, int length, out int needed);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")]
    static extern bool GetName(IntPtr obj, int index, StringBuilder info, int length, out int needed);
    const int UOI_FLAGS = 1, UOI_NAME = 2;
    const uint WSF_VISIBLE = 1;

    public static bool StationVisible() {
        var flags = new USEROBJECTFLAGS();
        int needed;
        if (!GetFlags(GetProcessWindowStation(), UOI_FLAGS, ref flags, Marshal.SizeOf(flags), out needed)) throw new Win32Exception();
        return (flags.dwFlags & WSF_VISIBLE) != 0;
    }

    public static string StationName() {
        var sb = new StringBuilder(256);
        int needed;
        if (!GetName(GetProcessWindowStation(), UOI_NAME, sb, sb.Capacity * 2, out needed)) throw new Win32Exception();
        return sb.ToString();
    }
}
'@
}

function Test-NewFile([string] $Directory) {
    # 'allowed' when a new file could be made (it is deleted again), 'denied' on access
    # denied, otherwise the error; 'not-set' without a directory.
    if (-not $Directory) { return 'not-set' }
    $target = Join-Path $Directory ('standard-user-probe-' + [guid]::NewGuid().ToString('N') + '.txt')
    try {
        $stream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
        $stream.Dispose()
    } catch {
        $e = $_.Exception
        while ($e -is [System.Management.Automation.MethodInvocationException] -and $e.InnerException) { $e = $e.InnerException }
        if ($e -is [System.UnauthorizedAccessException]) { return 'denied' }
        return "error: $($e.Message)"
    }
    Remove-Item -LiteralPath $target -Force
    'allowed'
}

$lines = @(& (Join-Path $env:SystemRoot 'System32\whoami.exe') /groups /fo csv /nh)
$lines | Set-Content -LiteralPath (Join-Path $env:STANDARD_USER_OUT 'probe-groups.csv') -Encoding utf8

$sids = @($lines | ForEach-Object { if ($_ -match '^"[^"]*","[^"]*","(S-1-[0-9-]+)"') { $Matches[1] } })
$label = @($sids | Where-Object { $_.StartsWith('S-1-16-') }) | Select-Object -First 1
$labelNames = @{
    'S-1-16-0' = 'Untrusted'; 'S-1-16-4096' = 'Low'; 'S-1-16-8192' = 'Medium'; 'S-1-16-8448' = 'Medium Plus'
    'S-1-16-12288' = 'High'; 'S-1-16-16384' = 'System'
}
$integrity = if ($label -and $labelNames.ContainsKey($label)) { $labelNames[$label] } else { 'unknown' }

$context = [ordered]@{
    userSid        = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    integritySid   = $label
    integrity      = $integrity
    interactive    = ($sids -contains 'S-1-5-4')
    batch          = ($sids -contains 'S-1-5-3')
    windowStation  = [ContextProbeNative]::StationName()
    wsfVisible     = [ContextProbeNative]::StationVisible()
    userProfile    = $env:USERPROFILE
    temp           = $env:TEMP
    workspaceWrite = Test-NewFile $env:GITHUB_WORKSPACE
}
$json = $context | ConvertTo-Json
$json | Set-Content -LiteralPath (Join-Path $env:STANDARD_USER_OUT 'context.json') -Encoding utf8
$json
exit 0
