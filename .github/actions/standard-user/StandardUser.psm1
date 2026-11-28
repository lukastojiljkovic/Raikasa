#Requires -Version 7.2
# SPDX-License-Identifier: MIT
<#
.SYNOPSIS
    The standard-user action (S-14) as functions that can be tested without a runner: the
    run itself (Invoke-StandardUserRun), the context check, the self-test gate, the
    exit-code mapping, the desktop and batch routes, the password, the child's wrapper,
    the cleanup stack and its removers, the read-only checks the runner proof makes after
    the cleanup, and the native calls. Class T (test tooling, never shipped).

.DESCRIPTION
    The context check is a pure function of the text that `whoami /groups /fo csv /nh`
    printed inside the child, of the token kind that was requested and, when given, of
    the child's `whoami /user /fo csv /nh` and the SID of the account the run created. It
    decides by SID only, so the display language does not matter, and it fails closed:
    empty or unparseable input never passes. A standard user's token:
      - holds the Medium integrity label S-1-16-8192 and no other label, so neither High
        (S-1-16-12288) nor System (S-1-16-16384);
      - holds no Administrators (S-1-5-32-544) in any form. A filtered administrator token
        carries it as "Group used for deny only", and a filtered administrator token is
        not a standard user (PerfWindow's specification, cross-pollination row 15). The
        same holds for S-1-5-114, "Local account and member of Administrators group",
        which Windows adds to every local administrator's token;
      - desktop kind: INTERACTIVE (S-1-5-4) present and BATCH (S-1-5-3) absent;
        batch kind: BATCH present and INTERACTIVE absent;
      - belongs to the account the run created (its user SID), when that SID is given.
    SIDs: https://learn.microsoft.com/en-us/windows/win32/secauthz/well-known-sids

    Exit codes of the run: the script's own when the check passes; 90 the token is not a
    standard user's; 91 the self-test cannot tell an elevated token; 92 the script never
    started as the user. The child's wrapper exits 93, without running the script, when
    it cannot record its token; the run reports that as 92.
#>

Set-StrictMode -Version Latest
# A module function does not see its caller's preference variables, so the module sets
# its own: an error inside it stops the step it happens in.
$ErrorActionPreference = 'Stop'

$script:SidMedium = 'S-1-16-8192'
$script:SidHigh = 'S-1-16-12288'
$script:SidSystem = 'S-1-16-16384'
$script:SidAdministrators = 'S-1-5-32-544'
$script:SidLocalAdministrator = 'S-1-5-114'
$script:SidUsers = 'S-1-5-32-545'
$script:SidInteractive = 'S-1-5-4'
$script:SidBatch = 'S-1-5-3'
$script:SidPattern = '^S-1-[0-9]+(-[0-9]+)+$'
# One row of `whoami /groups /fo csv /nh`: exactly four quoted fields.
$script:GroupRowPattern = '^"((?:[^"]|"")*)","((?:[^"]|"")*)","((?:[^"]|"")*)","((?:[^"]|"")*)"$'
# The one row of `whoami /user /fo csv /nh`: exactly two quoted fields.
$script:UserRowPattern = '^"((?:[^"]|"")*)","((?:[^"]|"")*)"$'

$script:ExitContextFailed = 90
$script:ExitSelfTest = 91
$script:ExitNeverStarted = 92
$script:ExitWrapperNoToken = 93

$script:RouteDescription = @{
    credential = 'Start-Process -Credential, CreateProcessWithLogonW through the Secondary Logon service'
    logonuser  = 'LogonUserW with LOGON32_LOGON_INTERACTIVE, then CreateProcessWithTokenW'
}

$script:Removers = @{
    'account'       = 'Remove-SUAccount'
    'folder-access' = 'Remove-SUFolderAccess'
    'temp-folder'   = 'Remove-SUTempFolder'
    'seclogon'      = 'Stop-SUSecondaryLogon'
    'station-grant' = 'Remove-SUStationGrant'
    'batch-right'   = 'Remove-SUBatchRight'
    'task'          = 'Remove-SUScheduledTask'
    'profile'       = 'Remove-SUProfile'
}

# ---------------------------------------------------------------- log and step outputs

function Write-RunnerLog {
    # One line on standard output, where the runner reads workflow commands.
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyString()] [string] $Text)
    [Console]::Out.WriteLine($Text)
}

function Add-StepOutput {
    # One step output, when the step runs on a runner.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [ValidatePattern('^[a-z][a-z-]*$')] [string] $Name,
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $Value
    )
    if ($Value -match '[\r\n]') { throw "the step output $Name may not hold a line break" }
    if ($env:GITHUB_OUTPUT) { Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "$Name=$Value" -Encoding utf8 }
}

function Format-ExitCode {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()] [object] $Code)
    if ($null -eq $Code) { return 'none' }
    $value = [int] $Code
    '{0} (0x{1})' -f $value, $value.ToString('X8')
}

# ---------------------------------------------------------------- the context check

function ConvertFrom-WhoamiGroupsCsv {
    <#
    .SYNOPSIS
        Parses the text of `whoami /groups /fo csv /nh`. Returns Ok, Rows (Name, Type, Sid,
        Attributes) and Error. Any line that is not exactly four quoted fields with a SID
        in the third makes the whole input unparseable.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([AllowNull()] [AllowEmptyString()] [string] $Text)

    $fail = { param($why) [pscustomobject]@{ Ok = $false; Rows = @(); Error = $why } }
    if ([string]::IsNullOrWhiteSpace($Text)) { return & $fail 'empty input: the child wrote no groups' }

    $rows = [System.Collections.Generic.List[object]]::new()
    $number = 0
    foreach ($raw in ($Text.TrimStart([char] 0xFEFF) -split '\r?\n')) {
        $number++
        $line = $raw.Trim()
        if ($line.Length -eq 0) { continue }
        $match = [regex]::Match($line, $script:GroupRowPattern)
        if (-not $match.Success) { return & $fail "line $number is not a row of whoami /groups /fo csv" }
        $sid = $match.Groups[3].Value.ToUpperInvariant()
        if ($sid -notmatch $script:SidPattern) { return & $fail "line $number has no SID in its third field" }
        $rows.Add([pscustomobject]@{
                Name       = $match.Groups[1].Value.Replace('""', '"')
                Type       = $match.Groups[2].Value.Replace('""', '"')
                Sid        = $sid
                Attributes = $match.Groups[4].Value.Replace('""', '"')
            })
    }
    if ($rows.Count -eq 0) { return & $fail 'empty input: the child wrote no groups' }
    [pscustomobject]@{ Ok = $true; Rows = $rows.ToArray(); Error = $null }
}

function ConvertFrom-WhoamiUserCsv {
    <#
    .SYNOPSIS
        Parses the text of `whoami /user /fo csv /nh`: exactly one row of two quoted
        fields with a SID in the second. Returns Ok, Name, Sid and Error.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([AllowNull()] [AllowEmptyString()] [string] $Text)

    $fail = { param($why) [pscustomobject]@{ Ok = $false; Name = $null; Sid = $null; Error = $why } }
    if ([string]::IsNullOrWhiteSpace($Text)) { return & $fail 'empty input: the child wrote no user' }
    $lines = @(($Text.TrimStart([char] 0xFEFF) -split '\r?\n') | ForEach-Object { $_.Trim() } | Where-Object { $_.Length })
    if ($lines.Count -ne 1) { return & $fail "expected one row of whoami /user /fo csv, found $($lines.Count)" }
    $match = [regex]::Match($lines[0], $script:UserRowPattern)
    if (-not $match.Success) { return & $fail 'the row is not one of whoami /user /fo csv' }
    $sid = $match.Groups[2].Value.ToUpperInvariant()
    if ($sid -notmatch $script:SidPattern) { return & $fail 'the row has no SID in its second field' }
    [pscustomobject]@{ Ok = $true; Name = $match.Groups[1].Value.Replace('""', '"'); Sid = $sid; Error = $null }
}

function Test-StandardUserContext {
    <#
    .SYNOPSIS
        Judges a token from the text of `whoami /groups /fo csv /nh`. Returns Passed, Kind,
        Reasons (Code, Privilege, Message) and Summary; Passed is true only with no reason
        at all. Privilege marks the reasons that show an elevated or administrator token.
        With -ExpectedUserSid, the text of `whoami /user /fo csv /nh` must name that SID.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [AllowNull()] [AllowEmptyString()] [string] $GroupsText,
        [Parameter(Mandatory)] [ValidateSet('desktop', 'batch')] [string] $Kind,
        [AllowNull()] [AllowEmptyString()] [string] $UserText,
        [ValidatePattern('^$|^S-1-[0-9]+(-[0-9]+)+$')] [string] $ExpectedUserSid = ''
    )

    $reasons = [System.Collections.Generic.List[object]]::new()
    $add = { param($code, $privilege, $message) $reasons.Add([pscustomobject]@{ Code = $code; Privilege = $privilege; Message = $message }) }

    $parsed = ConvertFrom-WhoamiGroupsCsv -Text $GroupsText
    if (-not $parsed.Ok) {
        & $add 'unparseable' $false "the groups cannot be read ($($parsed.Error)); failing closed"
    } else {
        $sids = @($parsed.Rows | ForEach-Object { $_.Sid })
        $labels = @($sids | Where-Object { $_.StartsWith('S-1-16-') } | Select-Object -Unique)

        if ($sids -notcontains $script:SidMedium) { & $add 'integrity-medium-absent' $false "not at Medium integrity ($script:SidMedium absent)" }
        if ($sids -contains $script:SidHigh) { & $add 'integrity-high' $true "High integrity ($script:SidHigh): the token is elevated" }
        if ($sids -contains $script:SidSystem) { & $add 'integrity-system' $true "System integrity ($script:SidSystem)" }
        $other = @($labels | Where-Object { $_ -notin $script:SidMedium, $script:SidHigh, $script:SidSystem })
        if ($other.Count) { & $add 'integrity-other' $false "an integrity label other than Medium ($($other -join ', '))" }

        $admin = @($parsed.Rows | Where-Object { $_.Sid -eq $script:SidAdministrators })
        if ($admin.Count) {
            & $add 'administrators' $true "Administrators ($script:SidAdministrators) is in the token ($($admin[0].Attributes)); a filtered administrator token, deny-only included, is not a standard user"
        }
        $localAdmin = @($parsed.Rows | Where-Object { $_.Sid -eq $script:SidLocalAdministrator })
        if ($localAdmin.Count) {
            & $add 'local-administrator' $true "Local account and member of Administrators group ($script:SidLocalAdministrator) is in the token ($($localAdmin[0].Attributes))"
        }

        if ($Kind -eq 'desktop') { $want = $script:SidInteractive; $not = $script:SidBatch }
        else { $want = $script:SidBatch; $not = $script:SidInteractive }
        if ($sids -notcontains $want) { & $add 'kind-absent' $false "logon SID $want absent: not a $Kind token" }
        if ($sids -contains $not) { & $add 'kind-wrong' $false "logon SID $not present: not a $Kind token" }
    }

    if ($ExpectedUserSid) {
        $who = ConvertFrom-WhoamiUserCsv -Text $UserText
        if (-not $who.Ok) {
            & $add 'user-unparseable' $false "the user cannot be read ($($who.Error)); failing closed"
        } elseif ($who.Sid -ne $ExpectedUserSid.ToUpperInvariant()) {
            & $add 'user-wrong' $false "the token belongs to $($who.Sid), not to the account this run created ($ExpectedUserSid)"
        }
    }

    [pscustomobject]@{
        Passed  = ($reasons.Count -eq 0)
        Kind    = $Kind
        Reasons = $reasons.ToArray()
        Summary = (($reasons | ForEach-Object { $_.Message }) -join '; ')
    }
}

function Test-SelfTestVerdict {
    <#
    .SYNOPSIS
        True when a verdict on the runner's own token shows the check can tell an elevated
        token: it failed, and for a privilege reason (not only the token kind or bad input).
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)] [pscustomobject] $Verdict)
    if ($Verdict.Passed) { return $false }
    [bool] @($Verdict.Reasons | Where-Object { $_.Privilege }).Count
}

function Resolve-SelfTest {
    <#
    .SYNOPSIS
        The self-test gate: Ok, ExitCode (91 when not Ok) and the line for the log.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [pscustomobject] $Verdict)
    if (Test-SelfTestVerdict -Verdict $Verdict) {
        return [pscustomobject]@{
            Ok       = $true
            ExitCode = $null
            Message  = "Self-test: the runner's own token fails the check as it must ($($Verdict.Summary))."
        }
    }
    $why = if ($Verdict.Passed) { 'it passed' } else { $Verdict.Summary }
    [pscustomobject]@{
        Ok       = $false
        ExitCode = $script:ExitSelfTest
        Message  = "::error::the context check does not fail on the runner's own token for a privilege reason, so it cannot tell an elevated token; the image changed (exit $script:ExitSelfTest). Verdict: $why"
    }
}

function Resolve-RunExitCode {
    <#
    .SYNOPSIS
        The step's exit code from what the child left behind: 92 when it never wrote its
        groups (the script never started as the user); otherwise the context check decides,
        90 when it fails and the script's own exit code when it passes (1 when the script
        left none). Returns ExitCode, Verdict ($null when not started) and the log line.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [ValidateSet('desktop', 'batch')] [string] $Kind,
        [Parameter(Mandatory)] [string] $Route,
        [Parameter(Mandatory)] [string] $AccountName,
        [Parameter(Mandatory)] [ValidatePattern('^S-1-[0-9]+(-[0-9]+)+$')] [string] $ExpectedUserSid,
        [Parameter(Mandatory)] [bool] $Started,
        [AllowNull()] [AllowEmptyString()] [string] $GroupsText,
        [AllowNull()] [AllowEmptyString()] [string] $UserText,
        [AllowNull()] [object] $ScriptExitCode
    )
    if (-not $Started) {
        return [pscustomobject]@{
            ExitCode = $script:ExitNeverStarted
            Verdict  = $null
            Message  = "::error::the script never started as $AccountName (no groups file; route $Route, child exit code $(Format-ExitCode $ScriptExitCode)) (exit $script:ExitNeverStarted)"
        }
    }
    $verdict = Test-StandardUserContext -GroupsText $GroupsText -Kind $Kind -UserText $UserText -ExpectedUserSid $ExpectedUserSid
    if (-not $verdict.Passed) {
        return [pscustomobject]@{
            ExitCode = $script:ExitContextFailed
            Verdict  = $verdict
            Message  = "::error::the $Kind token is not a standard user's (route $Route): $($verdict.Summary) (exit $script:ExitContextFailed)"
        }
    }
    $code = if ($null -eq $ScriptExitCode) { 1 } else { [int] $ScriptExitCode }
    $note =if ($null -eq $ScriptExitCode) { ' (the script left no exit code, so 1)' } else { '' }
    [pscustomobject]@{
        ExitCode = $code
        Verdict  = $verdict
        Message  = "Context check passed: a standard user's $Kind token at Medium integrity, of the account $AccountName (route $Route). Script exit code: $code$note."
    }
}

# ---------------------------------------------------------------- the desktop routes

function Get-DesktopRouteOrder {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [ValidateSet('auto', 'credential', 'logonuser')] [string] $Route)
    switch ($Route) {
        'auto' { 'credential', 'logonuser' }
        default { $Route }
    }
}

function Invoke-CredentialRoute {
    # Route 1: Start-Process -Credential (CreateProcessWithLogonW, interactive logon).
    # Returns ExitCode and TimedOut; whether the child started is told by its groups file.
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [hashtable] $Context)
    $credential = [pscredential]::new("$($Context.Domain)\$($Context.AccountName)", $Context.Password)
    $process = Start-Process -FilePath $Context.Pwsh -ArgumentList $Context.Arguments -Credential $credential -LoadUserProfile `
        -WorkingDirectory $Context.Workspace -WindowStyle Hidden -PassThru
    try {
        $null = $process.Handle # keeps the exit code readable after the process ends
        if (-not $process.WaitForExit($Context.TimeoutMinutes * 60000)) {
            $process.Kill($true)
            return [pscustomobject]@{ ExitCode = $null; TimedOut = $true }
        }
        [pscustomobject]@{ ExitCode = $process.ExitCode; TimedOut = $false }
    } catch {
        try { if (-not $process.HasExited) { $process.Kill($true) } }
        catch { Write-RunnerLog "::warning::the child $($process.Id) could not be stopped: $($_.Exception.Message)" }
        throw
    } finally {
        $process.Dispose()
    }
}

function Invoke-LogonUserRoute {
    # Route 2 (PerfWindow's specification, the second route): LogonUserW with
    # LOGON32_LOGON_INTERACTIVE, then CreateProcessWithTokenW with the same window station
    # and desktop grant. The password reaches LogonUserW as unmanaged memory that is
    # zeroed and freed right after the call. Returns ExitCode and TimedOut.
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [hashtable] $Context)
    Initialize-StandardUserNative
    $secret = [IntPtr]::Zero
    $processId = 0
    try {
        $secret = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($Context.Password)
        $handle = [StandardUserNative]::StartWithLogonToken($Context.AccountName, $Context.Domain, $secret, $Context.Pwsh,
            $Context.CommandLine, $Context.Workspace, $Context.Desktop, [ref] $processId)
    } finally {
        if ($secret -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($secret) }
    }
    $stop = {
        try { [System.Diagnostics.Process]::GetProcessById($processId).Kill($true) }
        catch { Write-RunnerLog "::warning::the child $processId could not be stopped: $($_.Exception.Message)" }
    }
    try {
        if (-not [StandardUserNative]::WaitProcess($handle, $Context.TimeoutMinutes * 60000)) {
            & $stop
            return [pscustomobject]@{ ExitCode = $null; TimedOut = $true }
        }
        [pscustomobject]@{ ExitCode = [StandardUserNative]::ProcessExitCode($handle); TimedOut = $false }
    } catch {
        & $stop
        throw
    } finally {
        [StandardUserNative]::CloseProcess($handle)
    }
}

function Format-AttemptProblem {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [pscustomobject] $Attempt)
    if ($Attempt.Error) { return $Attempt.Error }
    if ($Attempt.ExitCode -eq $script:ExitWrapperNoToken) {
        return "exit code $(Format-ExitCode $Attempt.ExitCode): the wrapper could not record the token, so the script was not run"
    }
    "exit code $(Format-ExitCode $Attempt.ExitCode)"
}

function Invoke-DesktopRun {
    <#
    .SYNOPSIS
        Runs the child under a desktop token by the routes of -Route, in order. Whether a
        child started as the user is told by its groups file alone, which the wrapper
        writes before it runs the script. A route whose child never started (no groups
        file, whether the route returned or threw) gives way to the next; a child that
        started, or timed out, ends the run, so the script never runs twice.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)] [ValidateSet('auto', 'credential', 'logonuser')] [string] $Route,
        [Parameter(Mandatory)] [hashtable] $Context
    )
    $attempts = [System.Collections.Generic.List[object]]::new()
    $last = $null
    foreach ($routeName in (Get-DesktopRouteOrder -Route $Route)) {
        Write-RunnerLog "Desktop route: $routeName ($($script:RouteDescription[$routeName]))."
        $exitCode = $null
        $timedOut = $false
        $problem = $null
        try {
            $result = if ($routeName -eq 'credential') { Invoke-CredentialRoute -Context $Context } else { Invoke-LogonUserRoute -Context $Context }
            $exitCode = $result.ExitCode
            $timedOut = [bool] $result.TimedOut
        } catch {
            $problem = $_.Exception.Message
        }
        $last = [pscustomobject]@{
            Route    = $routeName
            Started  = (Test-Path -LiteralPath $Context.GroupsFile)
            ExitCode = $exitCode
            TimedOut = $timedOut
            Error    = $problem
        }
        $attempts.Add($last)
        if ($last.Started -or $last.TimedOut) { break }
        Write-RunnerLog "Desktop route ${routeName}: the child never started as the user ($(Format-AttemptProblem -Attempt $last))."
    }
    [pscustomobject]@{
        Route    = $last.Route
        Started  = $last.Started
        ExitCode = $last.ExitCode
        TimedOut = $last.TimedOut
        Attempts = $attempts.ToArray()
    }
}

# ---------------------------------------------------------------- the batch route

function Test-TaskRunning {
    # 0x41301 (267009): the task is running; 0x41303 (267011): it has not yet run.
    [CmdletBinding()]
    [OutputType([bool])]
    param([AllowNull()] [object] $State, [AllowNull()] [object] $Result)
    ("$State" -ne 'Ready') -or ($null -ne $Result -and [int64] $Result -in 267009, 267011)
}

function ConvertFrom-TaskResult {
    # LastTaskResult is unsigned; an HRESULT such as 0x8007052F does not fit [int] as is.
    [CmdletBinding()]
    [OutputType([int])]
    param([AllowNull()] [object] $Result)
    if ($null -eq $Result) { return $null }
    $value = [int64] $Result
    if ($value -gt [int]::MaxValue) { $value -= 4294967296 }
    [int] $value
}

function Invoke-BatchRun {
    <#
    .SYNOPSIS
        Runs the child under a batch token: a scheduled task registered with the password
        at -RunLevel Limited, started with Start-ScheduledTask and polled until it ends.
        The password is a plain string only for the Register-ScheduledTask call.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [hashtable] $Context)
    # The ScheduledTasks commands are functions of another module, which the module's own
    # error preference does not reach, so every call states -ErrorAction Stop.
    Write-RunnerLog 'Batch route: a scheduled task registered with the password at -RunLevel Limited.'
    $action = New-ScheduledTaskAction -Execute $Context.Pwsh -Argument ($Context.Arguments -join ' ') -WorkingDirectory $Context.Workspace -ErrorAction Stop
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $Context.TimeoutMinutes) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ErrorAction Stop
    $plain = [System.Net.NetworkCredential]::new('', $Context.Password).Password
    try {
        $null = Register-ScheduledTask -TaskName $Context.TaskName -Action $action -Settings $settings `
            -User "$($Context.Domain)\$($Context.AccountName)" -Password $plain -RunLevel Limited -ErrorAction Stop
    } finally {
        $plain = $null
    }
    Start-ScheduledTask -TaskName $Context.TaskName -ErrorAction Stop
    $deadline = (Get-Date).AddMinutes($Context.TimeoutMinutes + 1)
    do {
        Start-Sleep -Seconds 2
        $taskState = (Get-ScheduledTask -TaskName $Context.TaskName -ErrorAction Stop).State
        $result = (Get-ScheduledTaskInfo -TaskName $Context.TaskName -ErrorAction Stop).LastTaskResult
        $running = Test-TaskRunning -State $taskState -Result $result
    } while ($running -and (Get-Date) -lt $deadline)
    if ($running) {
        try { Stop-ScheduledTask -TaskName $Context.TaskName -ErrorAction Stop }
        catch { Write-RunnerLog "::warning::the task $($Context.TaskName) could not be stopped: $($_.Exception.Message)" }
    }
    [pscustomobject]@{
        Route    = 'batch'
        Started  = (Test-Path -LiteralPath $Context.GroupsFile)
        ExitCode = if ($running) { $null } else { ConvertFrom-TaskResult -Result $result }
        TimedOut = $running
        Attempts = @()
    }
}

# ---------------------------------------------------------------- the account and the child

function New-StandardUserName {
    # 'ci' and 12 hex digits from the cryptographic generator: 14 characters, within the
    # 20 that New-LocalUser allows, and the only names Remove-SUAccount will delete.
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Returns a string only.')]
    [CmdletBinding()]
    [OutputType([string])]
    param()
    'ci' + [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(6)).ToLowerInvariant()
}

function New-StandardUserPassword {
    <#
    .SYNOPSIS
        A 32-character password from the cryptographic generator, with an upper-case
        letter, a lower-case letter, a digit and a symbol, returned as a read-only
        SecureString. With -EmitMask it first writes the runner's `::add-mask::` command for
        it, straight from a character array that is cleared afterwards; no managed string
        of it is made here.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Creates an in-memory value only.')]
    [CmdletBinding()]
    [OutputType([securestring])]
    param([switch] $EmitMask)
    $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
    $lower = 'abcdefghijkmnopqrstuvwxyz'
    $digits = '23456789'
    $symbols = '!#%+-.=?@_'
    $all = $upper + $lower + $digits + $symbols
    $rng = [System.Security.Cryptography.RandomNumberGenerator]
    $chars = [char[]]::new(32)
    try {
        $chars[0] = $upper[$rng::GetInt32($upper.Length)]
        $chars[1] = $lower[$rng::GetInt32($lower.Length)]
        $chars[2] = $digits[$rng::GetInt32($digits.Length)]
        $chars[3] = $symbols[$rng::GetInt32($symbols.Length)]
        for ($i = 4; $i -lt $chars.Length; $i++) { $chars[$i] = $all[$rng::GetInt32($all.Length)] }
        for ($i = $chars.Length - 1; $i -gt 0; $i--) {
            $j = $rng::GetInt32($i + 1)
            $swap = $chars[$i]; $chars[$i] = $chars[$j]; $chars[$j] = $swap
        }
        if ($EmitMask) {
            [Console]::Out.Write('::add-mask::')
            [Console]::Out.Write($chars)
            [Console]::Out.WriteLine()
        }
        $secure = [securestring]::new()
        foreach ($c in $chars) { $secure.AppendChar($c) }
        $secure.MakeReadOnly()
        $secure
    } finally {
        [Array]::Clear($chars, 0, $chars.Length)
        $swap = $c = $null
    }
}

function Find-SULocalUser {
    # The local account of that name, or nothing when there is none. Any other error
    # (access denied, say) is an error, so a cleanup never takes it for "already gone".
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $Name)
    try {
        Get-LocalUser -Name $Name
    } catch {
        if ($_.FullyQualifiedErrorId -like 'UserNotFound*') { return }
        throw
    }
}

function Get-RunnerGroupsText {
    # The runner's own `whoami /groups /fo csv /nh`, for the self-test.
    [CmdletBinding()]
    [OutputType([string])]
    param()
    (& (Join-Path $env:SystemRoot 'System32\whoami.exe') /groups /fo csv /nh) -join "`n"
}

function Get-ChildArgumentList {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [string] $Wrapper)
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$Wrapper`""
}

function Get-ChildCommandLine {
    # The full command line of the child for CreateProcessWithTokenW. It never holds a secret.
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [string] $Pwsh, [Parameter(Mandatory)] [string] $Wrapper)
    "`"$Pwsh`" " + ((Get-ChildArgumentList -Wrapper $Wrapper) -join ' ')
}

function New-WrapperText {
    <#
    .SYNOPSIS
        The script the child runs first. It records its own token before anything else:
        `whoami /user` into the user file, then `whoami /groups` into the groups file, which
        is the sign that the child started as the user. Only when both are written and the
        groups are not empty does it run the script under test, with its output in the log,
        and exit with the script's exit code. Otherwise it removes what it wrote and exits
        93 without running the script, so a fallback route never runs the script twice.
        It sets TEMP and TMP to -Temp, a folder the account owns: the child would otherwise
        inherit the runner account's, which is under a profile a standard user cannot enter
        ("Access to the path 'C:\Users\RUNNER~1\AppData' is denied").
        It holds no secret.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Returns text only.')]
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $Out,
        [Parameter(Mandatory)] [string] $GroupsFile,
        [Parameter(Mandatory)] [string] $UserFile,
        [Parameter(Mandatory)] [string] $Log,
        [Parameter(Mandatory)] [string] $ScriptPath,
        [Parameter(Mandatory)] [string] $Workspace,
        [Parameter(Mandatory)] [string] $Temp
    )
    $q = { param([string] $s) "'" + $s.Replace("'", "''") + "'" }
    @"
`$ErrorActionPreference = 'Continue'
`$env:STANDARD_USER_OUT = $(& $q $Out)
`$env:GITHUB_WORKSPACE = $(& $q $Workspace)
`$env:TEMP = $(& $q $Temp)
`$env:TMP = $(& $q $Temp)
`$whoami = Join-Path `$env:SystemRoot 'System32\whoami.exe'
try {
    & `$whoami /user /fo csv /nh | Set-Content -LiteralPath $(& $q $UserFile) -Encoding utf8 -ErrorAction Stop
    if (`$LASTEXITCODE) { throw "whoami /user exited `$LASTEXITCODE" }
    & `$whoami /groups /fo csv /nh | Set-Content -LiteralPath $(& $q $GroupsFile) -Encoding utf8 -ErrorAction Stop
    if (`$LASTEXITCODE) { throw "whoami /groups exited `$LASTEXITCODE" }
    if ((Get-Item -LiteralPath $(& $q $GroupsFile) -ErrorAction Stop).Length -eq 0) { throw 'the groups file is empty' }
} catch {
    Remove-Item -LiteralPath $(& $q $GroupsFile), $(& $q $UserFile) -Force -ErrorAction SilentlyContinue
    [Console]::Error.WriteLine("the wrapper could not record the token, so the script was not run: `$_")
    exit $script:ExitWrapperNoToken
}
`$global:LASTEXITCODE = 0
try { & $(& $q $ScriptPath) *>> $(& $q $Log); `$code = `$LASTEXITCODE } catch { `$_ | Out-String | Add-Content -LiteralPath $(& $q $Log); `$code = 1 }
exit `$code
"@
}

# ---------------------------------------------------------------- what the run grants

function Grant-SUFolderAccess {
    # One inheritable entry for the account on a folder, through the .NET ACL API (the
    # same API Remove-SUFolderAccess uses). Windows carries it to the folder's children.
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [ValidatePattern('^S-1-[0-9]+(-[0-9]+)+$')] [string] $Sid,
        [Parameter(Mandatory)] [ValidateSet('Modify', 'ReadAndExecute')] [string] $Rights
    )
    $folder = Get-Item -LiteralPath $Path -Force
    $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($folder, [System.Security.AccessControl.AccessControlSections]::Access)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($Sid),
        [System.Security.AccessControl.FileSystemRights] $Rights,
        [System.Security.AccessControl.InheritanceFlags] 'ContainerInherit, ObjectInherit',
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow)
    if ($PSCmdlet.ShouldProcess($Path, "Grant $Sid $Rights")) {
        $acl.AddAccessRule($rule)
        [System.IO.FileSystemAclExtensions]::SetAccessControl($folder, $acl)
    }
}

function New-SUTempFolder {
    # The child's TEMP and TMP. The runner account's own TEMP is under its profile, which a
    # standard user cannot enter, so every test that makes a temporary file would fail with
    # UnauthorizedAccessException. The folder is made here, under the runner temp, and its
    # DACL is protected from inheritance and holds three entries and no others: the account
    # (Modify), the identity that runs this action, which removes the folder again, and SYSTEM
    # (both FullControl). All three are inheritable, so what the child creates below it can
    # be deleted by the action too. Users, Everyone and Authenticated Users get nothing.
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [ValidatePattern('^S-1-[0-9]+(-[0-9]+)+$')] [string] $Sid
    )
    if ($PSCmdlet.ShouldProcess($Path, 'Create the standard user''s temporary folder')) {
        $folder = New-Item -ItemType Directory -Path $Path
        $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($folder, [System.Security.AccessControl.AccessControlSections]::Access)
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($entry in @(
                @{ Id = [System.Security.Principal.SecurityIdentifier]::new($Sid); Rights = 'Modify' }
                @{ Id = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; Rights = 'FullControl' }
                @{ Id = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'); Rights = 'FullControl' })) {
            $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
                    $entry.Id,
                    [System.Security.AccessControl.FileSystemRights] $entry.Rights,
                    [System.Security.AccessControl.InheritanceFlags] 'ContainerInherit, ObjectInherit',
                    [System.Security.AccessControl.PropagationFlags]::None,
                    [System.Security.AccessControl.AccessControlType]::Allow))
        }
        [System.IO.FileSystemAclExtensions]::SetAccessControl($folder, $acl)
        $Path
    }
}

function Grant-SUStationAccess {
    # Grants the account this process's window station and desktop; returns
    # "station\desktop" for the log and for lpDesktop.
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([string])]
    param([Parameter(Mandatory)] [byte[]] $SidBytes)
    Initialize-StandardUserNative
    if ($PSCmdlet.ShouldProcess('window station and desktop', 'Grant the account')) {
        [StandardUserNative]::SetStationAccess($SidBytes, $true)
    }
}

function Grant-SUBatchRight {
    # "Log on as a batch job" (SeBatchLogonRight) for the batch token.
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [byte[]] $SidBytes)
    Initialize-StandardUserNative
    if ($PSCmdlet.ShouldProcess('SeBatchLogonRight', 'Give the right to the account')) {
        [StandardUserNative]::AddAccountRight($SidBytes, 'SeBatchLogonRight')
    }
}

# ---------------------------------------------------------------- the run

function Invoke-StandardUserRun {
    <#
    .SYNOPSIS
        The whole step: the self-test, the account, the run under the token kind, the
        context check and the cleanup. Returns the step's exit code (see the module's
        description). Every item it creates is recorded before it is created and undone
        in `finally`, in reverse order, whatever happened.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)] [string] $Script,
        [Parameter(Mandatory)] [ValidateSet('desktop', 'batch')] [string] $Token,
        [ValidateRange(1, 360)] [int] $TimeoutMinutes = 30,
        [ValidateSet('auto', 'credential', 'logonuser')] [string] $DesktopRoute = 'auto',
        [Parameter(Mandatory)] [string] $Workspace,
        [Parameter(Mandatory)] [string] $RunnerTemp,
        [Parameter(Mandatory)] [string] $Pwsh
    )

    # 1. The self-test, before anything exists: the runner's own token must fail the
    # check for a privilege reason.
    $self = Test-StandardUserContext -GroupsText (Get-RunnerGroupsText) -Kind $Token
    $gate = Resolve-SelfTest -Verdict $self
    Write-RunnerLog $gate.Message
    if (-not $gate.Ok) { return [int] $gate.ExitCode }
    if ($Token -eq 'batch' -and $DesktopRoute -ne 'auto') {
        Write-RunnerLog "::notice::desktop-route '$DesktopRoute' applies to the desktop token only and is ignored for batch."
    }

    $scriptPath = (Resolve-Path -LiteralPath (Join-Path $Workspace $Script)).Path
    $name = New-StandardUserName
    $out = Join-Path $RunnerTemp "standard-user-$name"
    # The child's TEMP and TMP. Not under $out: that folder stays for the job's later steps,
    # this one is removed in the cleanup.
    $tempDir = Join-Path $RunnerTemp "su-temp-$name"
    $wrapper = Join-Path $out 'wrapper.ps1'
    $groupsFile = Join-Path $out 'groups.csv'
    $userFile = Join-Path $out 'user.csv'
    $log = Join-Path $out 'output.log'
    $state = [System.Collections.Generic.List[object]]::new()
    $secure = $null
    $code = $script:ExitNeverStarted
    # For cleanup.json: the account's SID and the "station\desktop" it was granted, empty
    # until they exist, so a later step can check that the cleanup left no entry for it.
    $accountSid = ''
    $grantedOn = ''
    try {
        $secure = New-StandardUserPassword -EmitMask

        # 2. The account. Its name is checked free and recorded before New-LocalUser runs,
        # so an account that New-LocalUser made before failing is removed too; the SID is
        # added to the record once it is known.
        if (Find-SULocalUser -Name $name) { throw "a local account named $name exists already; nothing was changed" }
        $account = Add-StandardUserItem -State $state -Kind account -Data @{ Name = $name; Sid = '' } -PassThru
        $user = New-LocalUser -Name $name -Password $secure -PasswordNeverExpires -AccountNeverExpires -Description 'CI standard user, deleted after this step'
        $sid = $user.SID
        $account.Data.Sid = $sid.Value
        $accountSid = $sid.Value
        try {
            Add-LocalGroupMember -SID $script:SidUsers -Member $name
        } catch {
            if ($_.Exception.GetType().Name -ne 'MemberExistsException' -and $_.FullyQualifiedErrorId -notlike 'MemberExists*') { throw }
        }
        $sidBytes = [byte[]]::new($sid.BinaryLength)
        $sid.GetBinaryForm($sidBytes, 0)
        Write-RunnerLog "Account $name ($($sid.Value)), member of Users only."

        $null = New-Item -ItemType Directory -Path $out
        Add-StandardUserItem -State $state -Kind folder-access -Data @{ Path = $out; Sid = $sid.Value }
        Grant-SUFolderAccess -Path $out -Sid $sid.Value -Rights Modify
        Add-StandardUserItem -State $state -Kind folder-access -Data @{ Path = $Workspace; Sid = $sid.Value }
        Grant-SUFolderAccess -Path $Workspace -Sid $sid.Value -Rights ReadAndExecute
        Add-StepOutput -Name out-dir -Value $out
        Add-StandardUserItem -State $state -Kind temp-folder -Data @{ Path = $tempDir }
        $null = New-SUTempFolder -Path $tempDir -Sid $sid.Value
        New-WrapperText -Out $out -GroupsFile $groupsFile -UserFile $userFile -Log $log -ScriptPath $scriptPath -Workspace $Workspace -Temp $tempDir |
            Set-Content -LiteralPath $wrapper -Encoding utf8

        $context = @{
            Pwsh           = $Pwsh
            Arguments      = Get-ChildArgumentList -Wrapper $wrapper
            CommandLine    = Get-ChildCommandLine -Pwsh $Pwsh -Wrapper $wrapper
            Workspace      = $Workspace
            AccountName    = $name
            Domain         = $env:COMPUTERNAME
            Password       = $secure
            Desktop        = ''
            TimeoutMinutes = $TimeoutMinutes
            GroupsFile     = $groupsFile
            UserFile       = $userFile
            TaskName       = "ci-standard-user-$name"
        }

        # 3. The run.
        if ($Token -eq 'desktop') {
            $seclogon = Get-Service -Name seclogon
            Write-RunnerLog "Secondary Logon (seclogon) before the run: $($seclogon.Status), start type $($seclogon.StartType)."
            if ($seclogon.Status -ne 'Running') {
                Add-StandardUserItem -State $state -Kind seclogon -Data @{}
                Start-Service -Name seclogon
            }
            Add-StandardUserItem -State $state -Kind station-grant -Data @{ SidBytes = $sidBytes }
            $context.Desktop = Grant-SUStationAccess -SidBytes $sidBytes
            $grantedOn = $context.Desktop
            Write-RunnerLog "Granted $name on $($context.Desktop)."
            Add-StandardUserItem -State $state -Kind profile -Data @{ Sid = $sid.Value }
            $run = Invoke-DesktopRun -Route $DesktopRoute -Context $context
        } else {
            Add-StandardUserItem -State $state -Kind batch-right -Data @{ SidBytes = $sidBytes }
            Grant-SUBatchRight -SidBytes $sidBytes
            Add-StandardUserItem -State $state -Kind task -Data @{ TaskName = $context.TaskName }
            Add-StandardUserItem -State $state -Kind profile -Data @{ Sid = $sid.Value }
            $run = Invoke-BatchRun -Context $context
        }
        Add-StepOutput -Name route -Value $run.Route
        if ($run.TimedOut) { throw "the script ran longer than $TimeoutMinutes minutes (route $($run.Route))" }
        if ($run.Started) {
            Write-RunnerLog "Route that ran: $($run.Route)."
        } elseif (@($run.Attempts).Count) {
            Write-RunnerLog "Routes tried: $((@($run.Attempts) | ForEach-Object { "$($_.Route): $(Format-AttemptProblem -Attempt $_)" }) -join '; ')."
        }

        # 4. What the script printed, then the context check on what the child recorded.
        if (Test-Path -LiteralPath $log) {
            Write-RunnerLog '::group::Output of the script'
            Get-Content -LiteralPath $log | ForEach-Object { Write-RunnerLog $_ }
            Write-RunnerLog '::endgroup::'
        }
        $started = Test-Path -LiteralPath $groupsFile
        $groupsText = if ($started) { Get-Content -LiteralPath $groupsFile -Raw } else { $null }
        $userText = if (Test-Path -LiteralPath $userFile) { Get-Content -LiteralPath $userFile -Raw } else { $null }
        $outcome = Resolve-RunExitCode -Kind $Token -Route $run.Route -AccountName $name -ExpectedUserSid $sid.Value -Started $started `
            -GroupsText $groupsText -UserText $userText -ScriptExitCode $run.ExitCode
        Write-RunnerLog $outcome.Message
        $code = $outcome.ExitCode
        [ordered]@{
            token          = $Token
            route          = $run.Route
            attempts       = @(@($run.Attempts) | ForEach-Object { [ordered]@{ route = $_.Route; started = $_.Started; exitCode = $_.ExitCode; error = $_.Error } })
            selfTest       = @(@($self.Reasons) | ForEach-Object { $_.Code })
            started        = $started
            scriptExitCode = $run.ExitCode
            contextCheck   = if ($null -eq $outcome.Verdict) { 'not-run' } elseif ($outcome.Verdict.Passed) { 'passed' } else { 'failed' }
            reasons        = @(if ($outcome.Verdict) { @($outcome.Verdict.Reasons) | ForEach-Object { $_.Code } })
            exitCode       = $code
        } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $out 'result.json') -Encoding utf8
    } finally {
        # 5. Cleanup, whatever happened above, in reverse order of creation.
        $failures = @(Invoke-StandardUserCleanup -State $state)
        foreach ($failure in $failures) { Write-RunnerLog "::warning::cleanup step not done: $failure" }
        if (Test-Path -LiteralPath $out) {
            $record = [ordered]@{
                accountSid = $accountSid
                desktop    = $grantedOn
                sessionId  = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
                failures   = $failures
            }
            try { $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'cleanup.json') -Encoding utf8 }
            catch { Write-RunnerLog "::warning::cleanup.json not written: $($_.Exception.Message)" }
        }
        if ($secure) { $secure.Dispose() }
    }
    $code
}

# ---------------------------------------------------------------- cleanup

function Add-StandardUserItem {
    <#
    .SYNOPSIS
        Records one thing the run creates, before it is created, so cleanup can undo it in
        reverse order. Every remover is a no-op when its thing does not exist. -PassThru
        returns the record, for data known only after the creation (the account's SID).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyCollection()] [System.Collections.Generic.List[object]] $State,
        [Parameter(Mandatory)] [ValidateSet('account', 'folder-access', 'temp-folder', 'seclogon', 'station-grant', 'batch-right', 'task', 'profile')] [string] $Kind,
        [Parameter(Mandatory)] [hashtable] $Data,
        [switch] $PassThru
    )
    $item = [pscustomobject]@{ Kind = $Kind; Data = $Data }
    $State.Add($item)
    if ($PassThru) { $item }
}

function Invoke-StandardUserCleanup {
    <#
    .SYNOPSIS
        Undoes the recorded items in reverse order of creation. A step that throws or
        writes an error counts as failed: it stays in the state for a retry, its message
        is returned, and the other steps still run.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [AllowEmptyCollection()] [System.Collections.Generic.List[object]] $State)
    $failures = [System.Collections.Generic.List[string]]::new()
    for ($i = $State.Count - 1; $i -ge 0; $i--) {
        $item = $State[$i]
        $data = $item.Data
        $stepErrors = $null
        try {
            & $script:Removers[$item.Kind] @data -ErrorAction Stop -ErrorVariable stepErrors 2>$null
            if ($stepErrors) { throw $stepErrors[0] }
            $State.RemoveAt($i)
        } catch {
            $failures.Add("$($item.Kind): $($_.Exception.Message)")
        }
    }
    $failures.ToArray()
}

function Remove-SUAccount {
    # Deletes the run's account, and only that one: the name has the run's pattern and,
    # once New-LocalUser returned, the SID must be the one it returned. With no SID
    # recorded, New-LocalUser did not return; the run checked the name was free before
    # creating it, so an account of that name is the one the run made.
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [ValidatePattern('^ci[0-9a-f]{12}$')] [string] $Name,
        [Parameter(Mandatory)] [AllowEmptyString()] [ValidatePattern('^$|^S-1-[0-9]+(-[0-9]+)+$')] [string] $Sid
    )
    $user = Find-SULocalUser -Name $Name
    if (-not $user) { return }
    if ($Sid -and $user.SID.Value -ne $Sid) { throw "the account $Name has SID $($user.SID.Value), not the account this run created ($Sid); it is left alone" }
    if ($PSCmdlet.ShouldProcess($Name, 'Remove the local account')) { Remove-LocalUser -SID $user.SID.Value }
}

function Remove-SUFolderAccess {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [ValidatePattern('^S-1-[0-9]+(-[0-9]+)+$')] [string] $Sid
    )
    # The .NET ACL API, not icacls: icacls cannot name a SID that no longer resolves (exit
    # 1332), and a retry may come after the account is gone. Explicit entries only; the
    # inherited ones below the folder go with them when the DACL is written back by name.
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $folder = Get-Item -LiteralPath $Path -Force
    $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($folder, [System.Security.AccessControl.AccessControlSections]::Access)
    $identity = [System.Security.Principal.SecurityIdentifier]::new($Sid)
    $mine = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference -eq $identity })
    if ($mine.Count -eq 0) { return }
    if ($PSCmdlet.ShouldProcess($Path, "Remove every entry for $Sid")) {
        $acl.PurgeAccessRules($identity)
        [System.IO.FileSystemAclExtensions]::SetAccessControl($folder, $acl)
    }
}

function Remove-SUTempFolder {
    # The folder New-SUTempFolder made, with whatever the child left in it. Only a folder of
    # the run's own pattern, under another folder, is removed.
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [ValidatePattern('[\\/]su-temp-ci[0-9a-f]{12}$')] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if ($PSCmdlet.ShouldProcess($Path, 'Remove the temporary folder')) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Stop-SUSecondaryLogon {
    # Stops seclogon again; recorded only when this run started it.
    [CmdletBinding(SupportsShouldProcess)]
    param()
    $service = Get-Service -Name seclogon
    if ($service.Status -ne 'Stopped' -and $PSCmdlet.ShouldProcess('seclogon', 'Stop the service')) {
        Stop-Service -Name seclogon
    }
}

function Remove-SUStationGrant {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [byte[]] $SidBytes)
    Initialize-StandardUserNative
    if ($PSCmdlet.ShouldProcess('window station and desktop', 'Revoke the account')) {
        $null = [StandardUserNative]::SetStationAccess($SidBytes, $false)
    }
}

function Remove-SUBatchRight {
    # Removes every right of the run's account and its LSA account object (LSA's
    # AllRights): the account was created by this run and given SeBatchLogonRight only.
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [byte[]] $SidBytes)
    Initialize-StandardUserNative
    if ($PSCmdlet.ShouldProcess('SeBatchLogonRight', 'Remove the rights of the account')) {
        [StandardUserNative]::RemoveAccountRights($SidBytes, 'SeBatchLogonRight')
    }
}

function Remove-SUScheduledTask {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [ValidatePattern('^ci-standard-user-ci[0-9a-f]{12}$')] [string] $TaskName)
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    } catch {
        if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return }
        throw
    }
    if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister the scheduled task')) {
        if ("$($task.State)" -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    }
}

function Remove-SUProfile {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] [ValidatePattern('^S-1-[0-9]+(-[0-9]+)+$')] [string] $Sid)
    $userProfile = Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$Sid'"
    if (-not $userProfile) { return }
    if ($PSCmdlet.ShouldProcess($Sid, 'Remove the user profile')) { $userProfile | Remove-CimInstance }
}

# ---------------------------------------------------------------- what the runner proof reads after the cleanup

function Measure-SUAceForSid {
    # The number of entries in a binary security descriptor's DACL that name the SID,
    # allow and deny alike; 0 without a DACL.
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)] [byte[]] $SecurityDescriptor,
        [Parameter(Mandatory)] [ValidatePattern('^S-1-[0-9]+(-[0-9]+)+$')] [string] $Sid
    )
    $acl = [System.Security.AccessControl.RawSecurityDescriptor]::new($SecurityDescriptor, 0).DiscretionaryAcl
    if ($null -eq $acl) { return 0 }
    $identity = [System.Security.Principal.SecurityIdentifier]::new($Sid)
    @($acl | Where-Object { $_ -is [System.Security.AccessControl.KnownAce] -and $_.SecurityIdentifier -eq $identity }).Count
}

function Get-SUStationEntry {
    <#
    .SYNOPSIS
        Reads, and never changes, the DACLs of this process's window station and this
        thread's desktop: the objects the desktop routes grant, as a later step of the same
        job inherits them. Returns Desktop ("station\desktop"), SessionId, and the number of
        entries that name the SID on each (StationEntries, DesktopEntries). The runner proof
        compares Desktop and SessionId with cleanup.json and requires both counts to be 0.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)] [ValidatePattern('^S-1-[0-9]+(-[0-9]+)+$')] [string] $Sid)
    Initialize-StandardUserNative
    $descriptors = [StandardUserNative]::ReadStationSecurity()
    [pscustomobject]@{
        Desktop        = [StandardUserNative]::StationDesktopName()
        SessionId      = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
        StationEntries = Measure-SUAceForSid -SecurityDescriptor $descriptors[0] -Sid $Sid
        DesktopEntries = Measure-SUAceForSid -SecurityDescriptor $descriptors[1] -Sid $Sid
    }
}

function Get-SUAccountRight {
    # The rights LSA holds for the SID (LsaEnumerateAccountRights). None when the SID has
    # no LSA account object; any other failure throws (unelevated, LSA refuses with access
    # denied), so an empty answer is always a real read.
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [ValidatePattern('^S-1-[0-9]+(-[0-9]+)+$')] [string] $Sid)
    Initialize-StandardUserNative
    $identity = [System.Security.Principal.SecurityIdentifier]::new($Sid)
    $bytes = [byte[]]::new($identity.BinaryLength)
    $identity.GetBinaryForm($bytes, 0)
    [StandardUserNative]::AccountRights($bytes)
}

# ---------------------------------------------------------------- native calls

$script:NativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class StandardUserNative {
    // ---- window station and desktop DACLs (CreateProcessWithLogonW's requirement) ----
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct TRUSTEE { public IntPtr pMultipleTrustee; public int MultipleTrusteeOperation; public int TrusteeForm; public int TrusteeType; public IntPtr ptstrName; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct EXPLICIT_ACCESS { public uint grfAccessPermissions; public int grfAccessMode; public uint grfInheritance; public TRUSTEE Trustee; }

    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr obj, int index, StringBuilder info, int length, out int needed);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenWindowStationW(string name, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseWindowStation(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr h);
    [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr handle, int objectType, int securityInfo, IntPtr owner, IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr sd);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint SetEntriesInAclW(int count, ref EXPLICIT_ACCESS entries, IntPtr oldAcl, out IntPtr newAcl);
    [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr handle, int objectType, int securityInfo, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr sd);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr mem);

    const int SE_WINDOW_OBJECT = 7, DACL_SECURITY_INFORMATION = 4, UOI_NAME = 2;
    const int GRANT_ACCESS = 1, REVOKE_ACCESS = 4, TRUSTEE_IS_SID = 0, TRUSTEE_IS_USER = 1;
    const uint READ_CONTROL = 0x00020000, WRITE_DAC = 0x00040000, STANDARD_RIGHTS_REQUIRED = 0x000F0000;
    // The full rights for now. PerfWindow's specification (section 4.3, item 2) asks for
    // the smallest set with which the child starts, measured on the runner and recorded
    // in its PR 8; these two masks are narrowed to that set then.
    const uint WINSTA_ALL_ACCESS = 0x0000037F, DESKTOP_ALL = 0x000001FF;

    static string ObjectName(IntPtr h) {
        var sb = new StringBuilder(256);
        int needed;
        if (!GetUserObjectInformationW(h, UOI_NAME, sb, sb.Capacity * 2, out needed)) throw new Win32Exception();
        return sb.ToString();
    }

    static void Apply(IntPtr handle, byte[] sid, uint mask, bool grant) {
        IntPtr dacl, sd;
        uint rc = GetSecurityInfo(handle, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, out dacl, IntPtr.Zero, out sd);
        if (rc != 0) throw new Win32Exception((int)rc);
        IntPtr psid = Marshal.AllocHGlobal(sid.Length);
        try {
            Marshal.Copy(sid, 0, psid, sid.Length);
            var ea = new EXPLICIT_ACCESS {
                grfAccessPermissions = mask, grfAccessMode = grant ? GRANT_ACCESS : REVOKE_ACCESS, grfInheritance = 0,
                Trustee = new TRUSTEE { TrusteeForm = TRUSTEE_IS_SID, TrusteeType = TRUSTEE_IS_USER, ptstrName = psid }
            };
            IntPtr newDacl;
            rc = SetEntriesInAclW(1, ref ea, dacl, out newDacl);
            if (rc != 0) throw new Win32Exception((int)rc);
            try {
                rc = SetSecurityInfo(handle, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, newDacl, IntPtr.Zero);
                if (rc != 0) throw new Win32Exception((int)rc);
            } finally { LocalFree(newDacl); }
        } finally { Marshal.FreeHGlobal(psid); LocalFree(sd); }
    }

    // Grants (or revokes) the account on this process's window station and this thread's
    // desktop, the ones a child of either desktop route uses. Revoking an absent entry
    // changes nothing. Returns "station\desktop" for the log and for lpDesktop.
    public static string SetStationAccess(byte[] sid, bool grant) {
        string station = ObjectName(GetProcessWindowStation());
        string desktop = ObjectName(GetThreadDesktop(GetCurrentThreadId()));
        IntPtr ws = OpenWindowStationW(station, false, READ_CONTROL | WRITE_DAC);
        if (ws == IntPtr.Zero) throw new Win32Exception();
        try { Apply(ws, sid, WINSTA_ALL_ACCESS | STANDARD_RIGHTS_REQUIRED, grant); } finally { CloseWindowStation(ws); }
        IntPtr dk = OpenDesktopW(desktop, 0, false, READ_CONTROL | WRITE_DAC);
        if (dk == IntPtr.Zero) throw new Win32Exception();
        try { Apply(dk, sid, DESKTOP_ALL | STANDARD_RIGHTS_REQUIRED, grant); } finally { CloseDesktop(dk); }
        return station + "\\" + desktop;
    }

    // "station\desktop" of this process's window station and this thread's desktop.
    public static string StationDesktopName() {
        return ObjectName(GetProcessWindowStation()) + "\\" + ObjectName(GetThreadDesktop(GetCurrentThreadId()));
    }

    static byte[] SecurityDescriptor(IntPtr handle) {
        IntPtr dacl, sd;
        uint rc = GetSecurityInfo(handle, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, out dacl, IntPtr.Zero, out sd);
        if (rc != 0) throw new Win32Exception((int)rc);
        try {
            var bytes = new byte[GetSecurityDescriptorLength(sd)];
            Marshal.Copy(sd, bytes, 0, bytes.Length);
            return bytes;
        } finally { LocalFree(sd); }
    }

    // The DACLs of the window station and desktop that SetStationAccess changes, opened
    // with READ_CONTROL only, as self-relative security descriptors: [0] the station,
    // [1] the desktop. Reads only; the runner proof checks with it that nothing is left.
    public static byte[][] ReadStationSecurity() {
        string station = ObjectName(GetProcessWindowStation());
        string desktop = ObjectName(GetThreadDesktop(GetCurrentThreadId()));
        var result = new byte[2][];
        IntPtr ws = OpenWindowStationW(station, false, READ_CONTROL);
        if (ws == IntPtr.Zero) throw new Win32Exception();
        try { result[0] = SecurityDescriptor(ws); } finally { CloseWindowStation(ws); }
        IntPtr dk = OpenDesktopW(desktop, 0, false, READ_CONTROL);
        if (dk == IntPtr.Zero) throw new Win32Exception();
        try { result[1] = SecurityDescriptor(dk); } finally { CloseDesktop(dk); }
        return result;
    }

    // ---- "Log on as a batch job" for the batch token ----
    [StructLayout(LayoutKind.Sequential)]
    struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)]
    struct LSA_OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
    [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr systemName, ref LSA_OBJECT_ATTRIBUTES attributes, uint access, out IntPtr policy);
    [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, LSA_UNICODE_STRING[] rights, uint count);
    // AllRights is a BOOLEAN, one byte.
    [DllImport("advapi32.dll")] static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, [MarshalAs(UnmanagedType.U1)] bool allRights, LSA_UNICODE_STRING[] rights, uint count);
    [DllImport("advapi32.dll")] static extern uint LsaEnumerateAccountRights(IntPtr policy, byte[] sid, out IntPtr rights, out uint count);
    [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr buffer);
    [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
    [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
    const uint POLICY_CREATE_ACCOUNT = 0x00000010, POLICY_LOOKUP_NAMES = 0x00000800;
    const uint STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034;

    static void WithRight(string right, Func<IntPtr, LSA_UNICODE_STRING[], uint> call, bool absentIsDone) {
        var oa = new LSA_OBJECT_ATTRIBUTES();
        oa.Length = Marshal.SizeOf(oa);
        IntPtr policy;
        uint st = LsaOpenPolicy(IntPtr.Zero, ref oa, POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES, out policy);
        if (st != 0) throw new Win32Exception(LsaNtStatusToWinError(st));
        IntPtr buffer = Marshal.StringToHGlobalUni(right);
        try {
            var s = new LSA_UNICODE_STRING { Buffer = buffer, Length = (ushort)(right.Length * 2), MaximumLength = (ushort)((right.Length + 1) * 2) };
            st = call(policy, new[] { s });
            if (st == STATUS_OBJECT_NAME_NOT_FOUND && absentIsDone) return;
            if (st != 0) throw new Win32Exception(LsaNtStatusToWinError(st));
        } finally { Marshal.FreeHGlobal(buffer); LsaClose(policy); }
    }

    // Gives the account one right.
    public static void AddAccountRight(byte[] sid, string right) {
        WithRight(right, (policy, rights) => LsaAddAccountRights(policy, sid, rights, 1), false);
    }

    // Removes every right of the account and deletes its LSA account object (AllRights
    // TRUE; LSA then ignores the list, which names the one right the run gave). An account
    // with no LSA object is not an error, so a retry is a no-op.
    public static void RemoveAccountRights(byte[] sid, string right) {
        WithRight(right, (policy, rights) => LsaRemoveAccountRights(policy, sid, true, rights, 1), true);
    }

    // The rights LSA holds for the account. An account with no LSA object holds none
    // (STATUS_OBJECT_NAME_NOT_FOUND); every other failure throws. The policy is opened
    // with POLICY_LOOKUP_NAMES only: this reads and never changes.
    public static string[] AccountRights(byte[] sid) {
        var oa = new LSA_OBJECT_ATTRIBUTES();
        oa.Length = Marshal.SizeOf(oa);
        IntPtr policy;
        uint st = LsaOpenPolicy(IntPtr.Zero, ref oa, POLICY_LOOKUP_NAMES, out policy);
        if (st != 0) throw new Win32Exception(LsaNtStatusToWinError(st));
        try {
            IntPtr rights;
            uint count;
            st = LsaEnumerateAccountRights(policy, sid, out rights, out count);
            if (st == STATUS_OBJECT_NAME_NOT_FOUND) return new string[0];
            if (st != 0) throw new Win32Exception(LsaNtStatusToWinError(st));
            try {
                var names = new string[count];
                int size = Marshal.SizeOf(typeof(LSA_UNICODE_STRING));
                for (int i = 0; i < count; i++) {
                    var s = (LSA_UNICODE_STRING)Marshal.PtrToStructure(IntPtr.Add(rights, i * size), typeof(LSA_UNICODE_STRING));
                    names[i] = Marshal.PtrToStringUni(s.Buffer, s.Length / 2);
                }
                return names;
            } finally { LsaFreeMemory(rights); }
        } finally { LsaClose(policy); }
    }

    // ---- the second desktop route: LogonUserW (interactive) and CreateProcessWithTokenW ----
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
        public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool LogonUserW(string user, string domain, IntPtr password, int logonType, int provider, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessWithTokenW(IntPtr token, int logonFlags, string applicationName, StringBuilder commandLine,
        int creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    const int LOGON32_LOGON_INTERACTIVE = 2, LOGON32_PROVIDER_DEFAULT = 0, LOGON_WITH_PROFILE = 1;
    const int CREATE_NEW_CONSOLE = 0x00000010, STARTF_USESHOWWINDOW = 0x00000001;
    const short SW_HIDE = 0;
    const uint WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 0x102;

    // Logs the account on interactively and starts the child with that token on the given
    // "station\desktop". The password is unmanaged memory the caller zeroes and frees.
    // Returns the process handle; the caller closes it with CloseProcess.
    public static IntPtr StartWithLogonToken(string user, string domain, IntPtr password, string application,
                                             string commandLine, string directory, string desktop, out int processId) {
        IntPtr token;
        if (!LogonUserW(user, domain, password, LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, out token)) throw new Win32Exception();
        try {
            var si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(si);
            si.lpDesktop = desktop;
            si.dwFlags = STARTF_USESHOWWINDOW;
            si.wShowWindow = SW_HIDE;
            PROCESS_INFORMATION pi;
            if (!CreateProcessWithTokenW(token, LOGON_WITH_PROFILE, application, new StringBuilder(commandLine),
                                         CREATE_NEW_CONSOLE, IntPtr.Zero, directory, ref si, out pi)) throw new Win32Exception();
            CloseHandle(pi.hThread);
            processId = pi.dwProcessId;
            return pi.hProcess;
        } finally { CloseHandle(token); }
    }

    // True when the process ended within the time, false on timeout.
    public static bool WaitProcess(IntPtr process, int milliseconds) {
        uint rc = WaitForSingleObject(process, (uint)milliseconds);
        if (rc == WAIT_OBJECT_0) return true;
        if (rc == WAIT_TIMEOUT) return false;
        throw new Win32Exception();
    }

    public static int ProcessExitCode(IntPtr process) {
        uint code;
        if (!GetExitCodeProcess(process, out code)) throw new Win32Exception();
        return unchecked((int)code);
    }

    public static void CloseProcess(IntPtr process) { if (process != IntPtr.Zero) CloseHandle(process); }
}
'@

function Initialize-StandardUserNative {
    # Compiles the native helper once per session (Add-Type; nothing is written to disk).
    [CmdletBinding()]
    param()
    if (-not ('StandardUserNative' -as [type])) { Add-Type -TypeDefinition $script:NativeSource }
}

Export-ModuleMember -Function @(
    'Write-RunnerLog', 'Add-StepOutput', 'Format-ExitCode',
    'ConvertFrom-WhoamiGroupsCsv', 'ConvertFrom-WhoamiUserCsv', 'Test-StandardUserContext', 'Test-SelfTestVerdict',
    'Resolve-SelfTest', 'Resolve-RunExitCode',
    'Get-DesktopRouteOrder', 'Invoke-CredentialRoute', 'Invoke-LogonUserRoute', 'Format-AttemptProblem', 'Invoke-DesktopRun',
    'Test-TaskRunning', 'ConvertFrom-TaskResult', 'Invoke-BatchRun',
    'New-StandardUserName', 'New-StandardUserPassword', 'Find-SULocalUser', 'Get-RunnerGroupsText',
    'Get-ChildArgumentList', 'Get-ChildCommandLine', 'New-WrapperText',
    'Grant-SUFolderAccess', 'New-SUTempFolder', 'Grant-SUStationAccess', 'Grant-SUBatchRight',
    'Invoke-StandardUserRun',
    'Add-StandardUserItem', 'Invoke-StandardUserCleanup',
    'Remove-SUAccount', 'Remove-SUFolderAccess', 'Remove-SUTempFolder', 'Stop-SUSecondaryLogon', 'Remove-SUStationGrant',
    'Remove-SUBatchRight', 'Remove-SUScheduledTask', 'Remove-SUProfile',
    'Measure-SUAceForSid', 'Get-SUStationEntry', 'Get-SUAccountRight',
    'Initialize-StandardUserNative'
)
