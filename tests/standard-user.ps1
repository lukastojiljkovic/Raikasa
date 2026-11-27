#Requires -Version 7.2
# SPDX-License-Identifier: MIT
<#
.SYNOPSIS
    Runs the unit tests as a standard user, from the published test executable.

.DESCRIPTION
    The standard-user job (ci.yml) publishes the test project into artifacts/standard-user and
    runs this script through .github/actions/standard-user, so it runs as a fresh account in
    the Users group, with the workspace as its working directory. None of the unit tests
    change the system, so every one of them must also pass without administrator rights; a
    test that quietly relies on an elevated token fails here and nowhere else, because
    GitHub's Windows runners run every other job elevated.

    The test project is an executable on Microsoft.Testing.Platform, so it needs only the
    shared runtime, not the SDK or the NuGet cache. The result is written to
    $env:STANDARD_USER_OUT as standard-user.trx. The exit code is the test run's own.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $env:STANDARD_USER_OUT) {
    [Console]::Error.WriteLine('STANDARD_USER_OUT is not set: run this script through the standard-user action.')
    exit 2
}

$published = Join-Path (Get-Location) 'artifacts/standard-user'
$exe = @(Get-ChildItem -LiteralPath $published -Filter '*.Core.Tests.exe' -File -ErrorAction SilentlyContinue)
if ($exe.Count -ne 1) {
    [Console]::Error.WriteLine("Expected one *.Core.Tests.exe in ${published}, found $($exe.Count): publish the test project first.")
    exit 2
}

# The account has no DOTNET_ROOT; the runner's shared runtime is under Program Files.
$runtimeRoot = Join-Path $env:ProgramFiles 'dotnet'
if (-not $env:DOTNET_ROOT -and (Test-Path -LiteralPath (Join-Path $runtimeRoot 'dotnet.exe'))) {
    $env:DOTNET_ROOT = $runtimeRoot
}

& $exe[0].FullName --report-trx --report-trx-filename standard-user.trx --results-directory $env:STANDARD_USER_OUT
exit $LASTEXITCODE
