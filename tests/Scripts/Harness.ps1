# SPDX-License-Identifier: MIT
# Shared by the *.Tests.ps1 files in this folder (Pester 5). It is dot-sourced in BeforeAll.
#
# The app runs each script from src/<name>.Core/Scripts in Windows PowerShell with a prelude
# that defines Emit and the script's parameters as variables. Here the same script runs in
# the test process: Emit hands its message back as output, the parameters are variables of
# the calling function, and every command that reads or changes the system is a stub, which
# the tests then mock, so no test touches the machine it runs on.
#
# Two Pester 5 rules the tests follow: a mock body sees a test's data only through
# .GetNewClosure(), and a closure cannot see the mocked command's parameters, so a mock that
# depends on a parameter is split into several mocks with a -ParameterFilter instead.

function Get-EmbeddedScriptsDirectory {
    $source = Join-Path $PSScriptRoot '../../src'
    $core = @(Get-ChildItem -LiteralPath $source -Directory -Filter '*.Core')
    if ($core.Count -ne 1) { throw "Expected one *.Core project under $source, found $($core.Count)." }
    Join-Path $core[0].FullName 'Scripts'
}

# Runs one embedded script and returns the messages it emitted, in order.
function Invoke-EmbeddedScript {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [hashtable] $Parameters = @{}
    )
    $ErrorActionPreference = 'Stop' # as the app's prelude sets it
    foreach ($key in $Parameters.Keys) { Set-Variable -Name $key -Value $Parameters[$key] }
    # Not $path: variable names are case-insensitive and a script may take a parameter called $Path.
    $scriptFile = Join-Path (Get-EmbeddedScriptsDirectory) "$Name.ps1"
    $messages = @(& $scriptFile | Where-Object { $_ -is [hashtable] })
    , $messages # the comma keeps one message from being unwrapped into a bare hashtable
}

# The app's Emit writes one JSON line; here the message itself is the output.
function Emit([hashtable] $Message) { $Message }

# Stubs of commands that may not exist on the machine that runs the tests (a runner has no
# Defender cmdlets, no Delivery Optimization and no DISM module), or that must never run.
function Get-MpComputerStatus {}
function Update-MpSignature {}
function Start-MpScan { param($ScanType) }
function Get-MpThreatDetection {}
function Get-MpThreat { param($ThreatID) }
function Delete-DeliveryOptimizationCache { param([switch] $Force) }
function Get-Volume { param([Parameter(ValueFromPipeline)] $InputObject, $DriveLetter) }
function Get-DiskImage { param($ImagePath) }
function Mount-DiskImage { param($ImagePath, $StorageType, $Access, [switch] $PassThru) }
function Get-WindowsImage { param($ImagePath, $Index) }
function Get-ComputerRestorePoint {}
function Checkpoint-Computer { param($Description, $RestorePointType) }
