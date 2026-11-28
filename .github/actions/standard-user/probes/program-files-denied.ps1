#Requires -Version 7.2
# SPDX-License-Identifier: MIT
<#
.SYNOPSIS
    Runner-proof probe, the clean proof: a standard user cannot write under Program Files.

.DESCRIPTION
    Tries to create a new file in -Directory (default: $env:ProgramFiles). Exit 0 when the
    write is denied (UnauthorizedAccessException), which is what a standard user must see;
    1 when the write succeeded (the file is deleted again), which means the token is not a
    standard user's; 2 when it failed for any other reason. It never overwrites a file:
    the name is new and the file is opened with CreateNew.
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
        "Denied, as a standard user must be: no write under $Directory."
        exit 0
    }
    "::error::the write under $Directory failed for another reason: $($e.Message)"
    exit 2
}
Remove-Item -LiteralPath $target -Force
"::error::wrote a file under ${Directory}: this token is not a standard user's."
exit 1
