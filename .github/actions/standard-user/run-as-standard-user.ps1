#Requires -Version 7.2
# SPDX-License-Identifier: MIT
<#
.SYNOPSIS
    Runs a script as a fresh standard local user and fails unless that user's token is
    really unelevated. Called by action.yml beside it; see its header for why. The run
    itself is Invoke-StandardUserRun in StandardUser.psm1, where its Pester tests reach it.

.DESCRIPTION
    1. Self-test. The runner's own token is judged by the same context check and must FAIL
       it for a privilege reason (High integrity, Administrators or the local
       administrator group): the runner is an administrator with UAC disabled. A check
       that never fails proves nothing, so this runs every time, before anything is
       created (exit 91 otherwise).
    2. The account. A random name and a random 32-character password from the
       cryptographic generator; member of Users (S-1-5-32-545) only. It may read the
       workspace and write one output folder, $env:STANDARD_USER_OUT.
    3. The run, by token kind:
         desktop  by -DesktopRoute, after the account is granted the window station and
                  desktop (Microsoft's page: "The application must add permission for the
                  specified user account to the inherited window station and desktop",
                  https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw):
                    credential  Start-Process -Credential: CreateProcessWithLogonW through
                                the Secondary Logon service, interactive logon;
                    logonuser   LogonUserW with LOGON32_LOGON_INTERACTIVE, then
                                CreateProcessWithTokenW (PerfWindow's specification, the
                                second route);
                    auto        credential, then logonuser when the child never started.
                  The log and the step output `route` say which route ran.
         batch    a scheduled task registered with the password at -RunLevel Limited and
                  started with Start-ScheduledTask. The account is given "Log on as a
                  batch job" (SeBatchLogonRight) for the run.
    4. The context check (Test-StandardUserContext), from `whoami /user` and
       `whoami /groups` written by the child itself before the script under test runs,
       by SID: Medium integrity present; High and System absent; Administrators and the
       local administrator group absent in any form, deny-only included; for desktop
       INTERACTIVE (S-1-5-4) present and BATCH (S-1-5-3) absent, for batch the reverse;
       the user SID that of the account this run created. Empty or unreadable files fail.
       The script under test is the repository's own code and could overwrite those
       files; the check guards against a wrong token, not against a hostile script.
    5. Cleanup in `finally`, whatever happened, in reverse order of creation (profile,
       task, batch right, station grant, seclogon, the two ACL entries, the account).
       Every item is recorded before it is created; the account by its name, which is
       checked free first, and its SID once New-LocalUser returns. Each step is a no-op
       when its item is gone, and a failing step does not stop the others. The output
       folder stays for the job's later steps, with result.json and cleanup.json;
       cleanup.json names the account's SID, the "station\desktop" it was granted and the
       session, so a later step can check that no entry for the account is left
       (Get-SUStationEntry and Get-SUAccountRight in the module).

    The password: generated into a character array, masked with `::add-mask::` before
    any other output that could hold it, then kept only as a read-only SecureString. It
    is never on a command line or in a log. LogonUserW gets it as unmanaged memory that is
    zeroed and freed after the call; Register-ScheduledTask takes a string, which exists
    only for that call.

    Exit code: the script's own exit code when the context check passes; 90 when the
    context check fails; 91 when the self-test cannot tell an elevated token; 92 when
    the script never started as the user.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Script,
    [Parameter(Mandatory)] [ValidateSet('desktop', 'batch')] [string] $Token,
    [ValidateRange(1, 360)] [int] $TimeoutMinutes = 30,
    [ValidateSet('auto', 'credential', 'logonuser')] [string] $DesktopRoute = 'auto'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'StandardUser.psm1') -Force

$code = Invoke-StandardUserRun -Script $Script -Token $Token -TimeoutMinutes $TimeoutMinutes -DesktopRoute $DesktopRoute `
    -Workspace $env:GITHUB_WORKSPACE -RunnerTemp $env:RUNNER_TEMP -Pwsh (Get-Process -Id $PID).Path
exit $code
