#Requires -Version 7.2
# SPDX-License-Identifier: MIT
<#
.SYNOPSIS
    Runner-proof probe, the planted failure: a test that needs to write under Program Files.

.DESCRIPTION
    Stands for a test with an access-denied bug that a standard user would hit. Run as a
    standard user it must fail, and the job with it: that proves the action passes the
    script's exit code through and that the account really is unprivileged. Run directly
    on an elevated runner it passes, which is the bug the action exists to catch.
    Tries to create a new file in -Directory (default: $env:ProgramFiles). Exit 1 when the
    write is denied; 0 when it succeeded (the file is deleted again); 2 for any other
    failure. It never overwrites a file: the name is new and the file is opened with
    CreateNew.
#>
[CmdletBinding()]
param([string] $Directory = $env:ProgramFiles)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$target = Join-Path $Directory ('standard-user-probe-' + [guid]::NewGuid().ToString('N') + '.txt')
try {
    $stream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    $stream.Dispose()
} catch {
    $e = $_.Exception
    while ($e -is [System.Management.Automation.MethodInvocationException] -and $e.InnerException) { $e = $e.InnerException }
    if ($e -is [System.UnauthorizedAccessException]) {
        "::error::access denied writing under ${Directory}: the planted failure, as expected for a standard user."
        exit 1
    }
    "::error::the write under $Directory failed for another reason: $($e.Message)"
    exit 2
}
Remove-Item -LiteralPath $target -Force
"Wrote and removed a file under $Directory."
exit 0
