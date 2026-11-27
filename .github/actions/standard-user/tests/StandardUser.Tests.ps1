#Requires -Version 7.2
# SPDX-License-Identifier: MIT
# Tests of the standard-user action (S-14): the run itself, the context check, the
# self-test gate, the exit codes, the desktop and batch routes, the secret handling, the
# cleanup, the wrapper, every command call's parameters, and the probes. Run with Pester 5:
#   Invoke-Pester -Path .github/actions/standard-user/tests/StandardUser.Tests.ps1 -Output Detailed
# Nothing here creates an account, a scheduled task or a right: every call that would
# is mocked, and the real removers are only called where they find nothing to remove.

BeforeAll {
    $script:ActionDir = Split-Path -Parent $PSScriptRoot
    Import-Module (Join-Path $script:ActionDir 'StandardUser.psm1') -Force
    $script:Fixtures = Join-Path $PSScriptRoot 'fixtures'
    $script:Pwsh = (Get-Process -Id $PID).Path
    # A throwaway value for the mocked runs; it is never a real account's password.
    $script:TestPassword = 'Test-only-0-not-a-secret!'

    function Read-Fixture([string] $Name) {
        Get-Content -LiteralPath (Join-Path $script:Fixtures $Name) -Raw -Encoding utf8
    }

    function Get-TestSecureString {
        $secure = [securestring]::new()
        foreach ($c in $script:TestPassword.ToCharArray()) { $secure.AppendChar($c) }
        $secure.MakeReadOnly()
        $secure
    }

    # Every command call in a piece of PowerShell, bound statically: a command or parameter
    # that does not exist, or a constant argument that the parameter's ValidateLength,
    # ValidateSet, ValidatePattern, ValidateRange or enum type refuses, is a problem; so is
    # a call to a function of another module (ScheduledTasks, say) without -ErrorAction,
    # because no caller's error preference reaches it. Dynamic provider parameters
    # (-Encoding, -Raw) are looked up for a file-system path. A script called by its path
    # is left out.
    function Get-CommandCallProblem([System.Management.Automation.Language.Ast] $Ast, [string] $Label) {
        $problems = [System.Collections.Generic.List[string]]::new()
        $local = @($Ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name })
        foreach ($call in $Ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
            $name = $call.GetCommandName()
            if (-not $name -or $name -in $local -or $name -match '[\\/]') { continue }
            $where = "${Label}:$($call.Extent.StartLineNumber) $name"
            $info = Get-Command -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($info -is [System.Management.Automation.AliasInfo]) { $info = $info.ResolvedCommand }
            if (-not $info) { $problems.Add("${where}: the command is not found"); continue }
            if ($info -isnot [System.Management.Automation.CmdletInfo] -and $info -isnot [System.Management.Automation.FunctionInfo]) { continue }
            $binding = [System.Management.Automation.Language.StaticParameterBinder]::BindCommand($call, $true)
            foreach ($key in $binding.BindingExceptions.Keys) {
                $errorId = $binding.BindingExceptions[$key].BindingException.ErrorId
                if ($errorId -eq 'NamedParameterNotFound') {
                    $all = (Get-Command -Name $info.Name -ArgumentList $PSScriptRoot).Parameters
                    if (@($all.Keys | Where-Object { $_ -like "$key*" }).Count) { continue }
                }
                $problems.Add("${where} -${key}: $errorId")
            }
            if ($info -is [System.Management.Automation.FunctionInfo] -and $info.ModuleName -and $info.ModuleName -ne 'StandardUser' -and
                -not $binding.BoundParameters.ContainsKey('ErrorAction')) {
                $problems.Add("${where}: a function of module $($info.ModuleName) called without -ErrorAction")
            }
            foreach ($entry in $binding.BoundParameters.GetEnumerator()) {
                $value = $entry.Value.ConstantValue
                if ($null -eq $value) { continue }
                $parameter = $entry.Value.Parameter
                $say = "${where} -$($parameter.Name) '$value'"
                foreach ($attribute in $parameter.Attributes) {
                    if ($attribute -is [System.Management.Automation.ValidateLengthAttribute] -and $value -is [string] -and
                        ($value.Length -lt $attribute.MinLength -or $value.Length -gt $attribute.MaxLength)) {
                        $problems.Add("${say}: $($value.Length) characters, the parameter takes $($attribute.MinLength) to $($attribute.MaxLength)")
                    }
                    if ($attribute -is [System.Management.Automation.ValidateSetAttribute]) {
                        $valid = $attribute.ValidValues
                        $inSet = if ($attribute.IgnoreCase) { $valid -contains $value } else { $valid -ccontains $value }
                        if (-not $inSet) { $problems.Add("${say}: not one of $($valid -join ', ')") }
                    }
                    if ($attribute -is [System.Management.Automation.ValidatePatternAttribute] -and
                        -not [regex]::IsMatch([string] $value, $attribute.RegexPattern, $attribute.Options)) {
                        $problems.Add("${say}: does not match $($attribute.RegexPattern)")
                    }
                    if ($attribute -is [System.Management.Automation.ValidateRangeAttribute] -and $null -ne $attribute.MinRange -and
                        ([double] $value -lt [double] $attribute.MinRange -or [double] $value -gt [double] $attribute.MaxRange)) {
                        $problems.Add("${say}: outside $($attribute.MinRange) to $($attribute.MaxRange)")
                    }
                    if ($attribute -is [System.Management.Automation.ValidateNotNullOrEmptyAttribute] -and $value -is [string] -and $value.Length -eq 0) {
                        $problems.Add("${say}: empty")
                    }
                }
                if ($parameter.ParameterType.IsEnum -and $value -is [string]) {
                    try { $null = [Enum]::Parse($parameter.ParameterType, $value, $true) }
                    catch { $problems.Add("${say}: not a value of $($parameter.ParameterType.Name)") }
                }
            }
        }
        , $problems.ToArray()
    }
}

AfterAll {
    Remove-Module StandardUser -Force -ErrorAction SilentlyContinue
}

Describe 'Test-StandardUserContext: the real filtered administrator token' {
    # Captured with `whoami /groups /fo csv /nh` from an agent shell on the development PC
    # (2026-11-18): Medium integrity, Administrators deny-only. Not a standard user.
    It 'fails the <Kind> kind' -TestCases @(@{ Kind = 'desktop' }, @{ Kind = 'batch' }) {
        $verdict = Test-StandardUserContext -GroupsText (Read-Fixture 'filtered-admin-session.csv') -Kind $Kind
        $verdict.Passed | Should -BeFalse
        $verdict.Reasons.Code | Should -Contain 'administrators'
        $verdict.Reasons.Code | Should -Contain 'local-administrator'
    }

    It 'counts as a meaningful self-test (it fails for a privilege reason)' {
        $verdict = Test-StandardUserContext -GroupsText (Read-Fixture 'filtered-admin-session.csv') -Kind desktop
        Test-SelfTestVerdict -Verdict $verdict | Should -BeTrue
    }
}

Describe 'Test-StandardUserContext: standard tokens pass only their own kind' {
    It 'passes a standard desktop token as desktop' {
        $verdict = Test-StandardUserContext -GroupsText (Read-Fixture 'standard-desktop.csv') -Kind desktop
        $verdict.Passed | Should -BeTrue
        @($verdict.Reasons).Count | Should -Be 0
    }

    It 'fails a standard desktop token as batch' {
        $verdict = Test-StandardUserContext -GroupsText (Read-Fixture 'standard-desktop.csv') -Kind batch
        $verdict.Passed | Should -BeFalse
        $verdict.Reasons.Code | Should -Contain 'kind-absent'
        $verdict.Reasons.Code | Should -Contain 'kind-wrong'
    }

    It 'passes a standard batch token as batch' {
        $verdict = Test-StandardUserContext -GroupsText (Read-Fixture 'standard-batch.csv') -Kind batch
        $verdict.Passed | Should -BeTrue
    }

    It 'fails a standard batch token as desktop' {
        $verdict = Test-StandardUserContext -GroupsText (Read-Fixture 'standard-batch.csv') -Kind desktop
        $verdict.Passed | Should -BeFalse
        $verdict.Reasons.Code | Should -Contain 'kind-absent'
        $verdict.Reasons.Code | Should -Contain 'kind-wrong'
    }

    It 'decides by SID, so a localized token with the right SIDs passes desktop' {
        $verdict = Test-StandardUserContext -GroupsText (Read-Fixture 'localized-desktop.csv') -Kind desktop
        $verdict.Passed | Should -BeTrue
    }

    It 'a standard token is not a meaningful self-test' {
        $verdict = Test-StandardUserContext -GroupsText (Read-Fixture 'standard-desktop.csv') -Kind desktop
        Test-SelfTestVerdict -Verdict $verdict | Should -BeFalse
    }

    It 'a failure for the token kind alone is not a meaningful self-test' {
        $verdict = Test-StandardUserContext -GroupsText (Read-Fixture 'standard-desktop.csv') -Kind batch
        Test-SelfTestVerdict -Verdict $verdict | Should -BeFalse
    }
}

Describe 'Test-StandardUserContext: every unsafe token fails closed' {
    It '<File> fails the <Kind> kind with <Code>' -TestCases @(
        @{ File = 'high-label.csv'; Kind = 'desktop'; Code = 'integrity-high' }
        @{ File = 'high-label.csv'; Kind = 'batch'; Code = 'integrity-high' }
        @{ File = 'system-label.csv'; Kind = 'desktop'; Code = 'integrity-system' }
        @{ File = 'system-label.csv'; Kind = 'batch'; Code = 'integrity-system' }
        @{ File = 'missing-medium.csv'; Kind = 'desktop'; Code = 'integrity-medium-absent' }
        @{ File = 'missing-medium.csv'; Kind = 'batch'; Code = 'integrity-medium-absent' }
        @{ File = 'admin-enabled.csv'; Kind = 'desktop'; Code = 'administrators' }
        @{ File = 'admin-enabled.csv'; Kind = 'batch'; Code = 'administrators' }
        @{ File = 'admin-deny-only.csv'; Kind = 'desktop'; Code = 'administrators' }
        @{ File = 'admin-deny-only.csv'; Kind = 'batch'; Code = 'administrators' }
        @{ File = 'local-admin-deny-only.csv'; Kind = 'desktop'; Code = 'local-administrator' }
        @{ File = 'both-logon.csv'; Kind = 'desktop'; Code = 'kind-wrong' }
        @{ File = 'both-logon.csv'; Kind = 'batch'; Code = 'kind-wrong' }
        @{ File = 'empty.csv'; Kind = 'desktop'; Code = 'unparseable' }
        @{ File = 'empty.csv'; Kind = 'batch'; Code = 'unparseable' }
        @{ File = 'garbage.csv'; Kind = 'desktop'; Code = 'unparseable' }
        @{ File = 'garbage.csv'; Kind = 'batch'; Code = 'unparseable' }
    ) {
        $verdict = Test-StandardUserContext -GroupsText (Read-Fixture $File) -Kind $Kind
        $verdict.Passed | Should -BeFalse
        $verdict.Reasons.Code | Should -Contain $Code
    }

    It 'fails only on deny-only Administrators in the admin-deny-only fixture (the rule is isolated)' {
        $verdict = Test-StandardUserContext -GroupsText (Read-Fixture 'admin-deny-only.csv') -Kind desktop
        @($verdict.Reasons.Code) | Should -Be @('administrators')
    }

    It 'fails only on BATCH in the both-logon fixture for desktop (the rule is isolated)' {
        $verdict = Test-StandardUserContext -GroupsText (Read-Fixture 'both-logon.csv') -Kind desktop
        @($verdict.Reasons.Code) | Should -Be @('kind-wrong')
        $verdict.Reasons[0].Message | Should -Match 'S-1-5-3'
    }

    It 'fails closed on null input' {
        (Test-StandardUserContext -GroupsText $null -Kind desktop).Reasons.Code | Should -Contain 'unparseable'
    }

    It 'fails closed on whitespace only' {
        (Test-StandardUserContext -GroupsText "  `r`n `r`n" -Kind desktop).Reasons.Code | Should -Contain 'unparseable'
    }

    It 'fails closed when one line of a valid table is malformed' {
        $text = (Read-Fixture 'standard-desktop.csv') + "`r`n" + 'not,a,row'
        $verdict = Test-StandardUserContext -GroupsText $text -Kind desktop
        $verdict.Passed | Should -BeFalse
        $verdict.Reasons.Code | Should -Contain 'unparseable'
    }

    It 'fails closed when a row has no SID in its third field' {
        $text = (Read-Fixture 'standard-desktop.csv') + "`r`n" + '"Everyone","Well-known group","Everyone",""'
        (Test-StandardUserContext -GroupsText $text -Kind desktop).Reasons.Code | Should -Contain 'unparseable'
    }

    It 'fails a Low integrity token' {
        $text = (Read-Fixture 'standard-desktop.csv') -replace 'S-1-16-8192', 'S-1-16-4096'
        $verdict = Test-StandardUserContext -GroupsText $text -Kind desktop
        $verdict.Reasons.Code | Should -Contain 'integrity-medium-absent'
        $verdict.Reasons.Code | Should -Contain 'integrity-other'
    }

    It 'does not mistake S-1-5-42 for INTERACTIVE or S-1-5-32-5440 for Administrators' {
        $text = (Read-Fixture 'standard-desktop.csv') -replace '"S-1-5-4"', '"S-1-5-42"'
        $text += "`r`n" + '"X","Alias","S-1-5-32-5440","Group used for deny only"'
        $verdict = Test-StandardUserContext -GroupsText $text -Kind desktop
        @($verdict.Reasons.Code) | Should -Be @('kind-absent')
    }

    It 'rejects an unknown token kind' {
        { Test-StandardUserContext -GroupsText (Read-Fixture 'standard-desktop.csv') -Kind 'service' } | Should -Throw -ErrorId 'ParameterArgumentValidationError*'
    }

    It 'a parse failure is not a meaningful self-test' {
        $verdict = Test-StandardUserContext -GroupsText (Read-Fixture 'garbage.csv') -Kind desktop
        Test-SelfTestVerdict -Verdict $verdict | Should -BeFalse
    }
}

Describe 'Test-StandardUserContext: the token belongs to the account the run created' {
    BeforeAll {
        $script:Groups = Read-Fixture 'standard-desktop.csv'
        $script:Mine = 'S-1-5-21-1-2-3-1001'
    }

    It 'passes when whoami /user names the expected SID' {
        $verdict = Test-StandardUserContext -GroupsText $script:Groups -Kind desktop -UserText '"HOST\ci000000000000","S-1-5-21-1-2-3-1001"' -ExpectedUserSid $script:Mine
        $verdict.Passed | Should -BeTrue
    }

    It 'fails with user-wrong for another account''s token' {
        $verdict = Test-StandardUserContext -GroupsText $script:Groups -Kind desktop -UserText '"HOST\other","S-1-5-21-1-2-3-1002"' -ExpectedUserSid $script:Mine
        @($verdict.Reasons.Code) | Should -Be @('user-wrong')
    }

    It 'fails closed with user-unparseable on <Why>' -TestCases @(
        @{ Why = 'no user text'; Text = $null }
        @{ Why = 'an empty user text'; Text = '' }
        @{ Why = 'two rows'; Text = "`"A`",`"S-1-5-21-1-2-3-1001`"`r`n`"B`",`"S-1-5-21-1-2-3-1001`"" }
        @{ Why = 'a groups row'; Text = '"Everyone","Well-known group","S-1-1-0",""' }
        @{ Why = 'no SID'; Text = '"HOST\ci000000000000","nobody"' }
    ) {
        $verdict = Test-StandardUserContext -GroupsText $script:Groups -Kind desktop -UserText $Text -ExpectedUserSid $script:Mine
        @($verdict.Reasons.Code) | Should -Be @('user-unparseable')
    }

    It 'leaves the user out when no SID is expected (the self-test)' {
        (Test-StandardUserContext -GroupsText $script:Groups -Kind desktop -UserText 'garbage').Passed | Should -BeTrue
    }

    It 'reads the real whoami /user row of this process' {
        $row = (& "$env:SystemRoot\System32\whoami.exe" /user /fo csv /nh) -join "`n"
        $who = ConvertFrom-WhoamiUserCsv -Text $row
        $who.Ok | Should -BeTrue
        $who.Sid | Should -Be ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    }
}

Describe 'Test-StandardUserContext on this process''s own token' -Tag 'Live' {
    # The self-test logic: run by an administrator (a CI runner, or an agent shell on the
    # development PC with its filtered token), the check must fail for a privilege reason.
    It 'fails the <Kind> kind and is a meaningful self-test' -TestCases @(@{ Kind = 'desktop' }, @{ Kind = 'batch' }) {
        $verdict = Test-StandardUserContext -GroupsText (Get-RunnerGroupsText) -Kind $Kind
        $verdict.Passed | Should -BeFalse
        Test-SelfTestVerdict -Verdict $verdict | Should -BeTrue
        (Resolve-SelfTest -Verdict $verdict).Ok | Should -BeTrue
    }
}

Describe 'Resolve-SelfTest: the gate before anything is created' {
    It 'lets a meaningful self-test through with the Self-test line' {
        $gate = Resolve-SelfTest -Verdict (Test-StandardUserContext -GroupsText (Read-Fixture 'filtered-admin-session.csv') -Kind desktop)
        $gate.Ok | Should -BeTrue
        $gate.ExitCode | Should -BeNullOrEmpty
        $gate.Message | Should -BeLike "Self-test: the runner's own token fails the check as it must (*"
    }

    It 'stops with 91 when <Why>' -TestCases @(
        @{ Why = 'the runner token passes'; File = 'standard-desktop.csv'; Kind = 'desktop' }
        @{ Why = 'it fails for the token kind only'; File = 'standard-batch.csv'; Kind = 'desktop' }
        @{ Why = 'the groups cannot be read'; File = 'garbage.csv'; Kind = 'batch' }
    ) {
        $gate = Resolve-SelfTest -Verdict (Test-StandardUserContext -GroupsText (Read-Fixture $File) -Kind $Kind)
        $gate.Ok | Should -BeFalse
        $gate.ExitCode | Should -Be 91
        $gate.Message | Should -BeLike '::error::*(exit 91)*'
    }
}

Describe 'Resolve-RunExitCode: the verdict decides the exit code' {
    BeforeAll {
        $script:Common = @{ Route = 'credential'; AccountName = 'ci000000000000'; ExpectedUserSid = 'S-1-5-21-1-2-3-1001' }
        $script:User = '"HOST\ci000000000000","S-1-5-21-1-2-3-1001"'
    }

    BeforeEach {
        $common = $script:Common
    }

    It 'gives the script''s own exit code <Code> when the check passes' -TestCases @(@{ Code = 0 }, @{ Code = 7 }, @{ Code = -2 }) {
        $outcome = Resolve-RunExitCode @common -Kind desktop -Started $true -GroupsText (Read-Fixture 'standard-desktop.csv') -UserText $script:User -ScriptExitCode $Code
        $outcome.ExitCode | Should -Be $Code
        $outcome.Verdict.Passed | Should -BeTrue
        $outcome.Message | Should -BeLike "Context check passed*Script exit code: $Code."
    }

    It 'gives 1, failing closed, when the passing script left no exit code' {
        (Resolve-RunExitCode @common -Kind desktop -Started $true -GroupsText (Read-Fixture 'standard-desktop.csv') -UserText $script:User -ScriptExitCode $null).ExitCode | Should -Be 1
    }

    It 'gives 90, not the script''s 0, when the check fails: <Why>' -TestCases @(
        @{ Why = 'a batch token for desktop'; Kind = 'desktop'; File = 'standard-batch.csv' }
        @{ Why = 'a desktop token for batch'; Kind = 'batch'; File = 'standard-desktop.csv' }
        @{ Why = 'the filtered administrator token'; Kind = 'desktop'; File = 'filtered-admin-session.csv' }
        @{ Why = 'an empty groups file'; Kind = 'desktop'; File = 'empty.csv' }
    ) {
        $outcome = Resolve-RunExitCode @common -Kind $Kind -Started $true -GroupsText (Read-Fixture $File) -UserText $script:User -ScriptExitCode 0
        $outcome.ExitCode | Should -Be 90
        $outcome.Message | Should -BeLike '::error::*(exit 90)'
    }

    It 'gives 90 when the token belongs to another account' {
        (Resolve-RunExitCode @common -Kind desktop -Started $true -GroupsText (Read-Fixture 'standard-desktop.csv') -UserText '"HOST\x","S-1-5-21-9-9-9-500"' -ScriptExitCode 0).ExitCode | Should -Be 90
    }

    It 'gives 92 when the child never wrote its groups' {
        $outcome = Resolve-RunExitCode @common -Kind desktop -Started $false -GroupsText $null -UserText $null -ScriptExitCode 93
        $outcome.ExitCode | Should -Be 92
        $outcome.Verdict | Should -BeNullOrEmpty
        $outcome.Message | Should -BeLike '::error::the script never started as ci000000000000*93*(exit 92)'
    }
}

Describe 'Get-DesktopRouteOrder' {
    It 'auto tries credential, then logonuser' {
        Get-DesktopRouteOrder -Route auto | Should -Be @('credential', 'logonuser')
    }
    It 'credential tries only credential' {
        @(Get-DesktopRouteOrder -Route credential) | Should -Be @('credential')
    }
    It 'logonuser tries only logonuser' {
        @(Get-DesktopRouteOrder -Route logonuser) | Should -Be @('logonuser')
    }
    It 'rejects an unknown route' {
        { Get-DesktopRouteOrder -Route 'runas' } | Should -Throw -ErrorId 'ParameterArgumentValidationError*'
    }
}

Describe 'Invoke-DesktopRun: route selection with mocked native calls' {
    BeforeEach {
        $script:Context = @{ GroupsFile = Join-Path $TestDrive 'route-groups.csv' }
        Remove-Item -LiteralPath $script:Context.GroupsFile -ErrorAction SilentlyContinue
        $script:Log = [System.Collections.Generic.List[string]]::new()
        Mock Write-RunnerLog -ModuleName StandardUser { $script:Log.Add($Text) }
    }

    It 'auto stops after credential when the child started' {
        Mock Invoke-CredentialRoute -ModuleName StandardUser { Set-Content -LiteralPath $Context.GroupsFile -Value 'x'; [pscustomobject]@{ ExitCode = 0; TimedOut = $false } }
        Mock Invoke-LogonUserRoute -ModuleName StandardUser { throw 'must not run' }
        $run = Invoke-DesktopRun -Route auto -Context $script:Context
        $run.Route | Should -Be 'credential'
        $run.Started | Should -BeTrue
        $run.ExitCode | Should -Be 0
        @($run.Attempts).Count | Should -Be 1
        Should -Invoke Invoke-LogonUserRoute -ModuleName StandardUser -Times 0 -Exactly
    }

    It 'auto falls back to logonuser when the credential child never started' {
        Mock Invoke-CredentialRoute -ModuleName StandardUser { [pscustomobject]@{ ExitCode = -1073741502; TimedOut = $false } }
        Mock Invoke-LogonUserRoute -ModuleName StandardUser { Set-Content -LiteralPath $Context.GroupsFile -Value 'x'; [pscustomobject]@{ ExitCode = 7; TimedOut = $false } }
        $run = Invoke-DesktopRun -Route auto -Context $script:Context
        $run.Route | Should -Be 'logonuser'
        $run.Started | Should -BeTrue
        $run.ExitCode | Should -Be 7
        @($run.Attempts).Count | Should -Be 2
        $run.Attempts[0].Route | Should -Be 'credential'
        $run.Attempts[0].Started | Should -BeFalse
        Should -Invoke Invoke-CredentialRoute -ModuleName StandardUser -Times 1 -Exactly
        Should -Invoke Invoke-LogonUserRoute -ModuleName StandardUser -Times 1 -Exactly
    }

    It 'auto falls back to logonuser when the credential route throws before the child starts' {
        Mock Invoke-CredentialRoute -ModuleName StandardUser { throw 'This command cannot be run due to the error: Access is denied.' }
        Mock Invoke-LogonUserRoute -ModuleName StandardUser { Set-Content -LiteralPath $Context.GroupsFile -Value 'x'; [pscustomobject]@{ ExitCode = 0; TimedOut = $false } }
        $run = Invoke-DesktopRun -Route auto -Context $script:Context
        $run.Route | Should -Be 'logonuser'
        $run.Attempts[0].Error | Should -Match 'Access is denied'
    }

    It 'never falls back once the child started, even when the route then throws (the script must not run twice)' {
        Mock Invoke-CredentialRoute -ModuleName StandardUser { Set-Content -LiteralPath $Context.GroupsFile -Value 'x'; throw 'WaitForExit failed' }
        Mock Invoke-LogonUserRoute -ModuleName StandardUser { throw 'must not run' }
        $run = Invoke-DesktopRun -Route auto -Context $script:Context
        $run.Route | Should -Be 'credential'
        $run.Started | Should -BeTrue
        $run.ExitCode | Should -BeNullOrEmpty
        $run.Attempts[0].Error | Should -Be 'WaitForExit failed'
        Should -Invoke Invoke-LogonUserRoute -ModuleName StandardUser -Times 0 -Exactly
    }

    It 'says so when the wrapper could not record the token (exit 93), and falls back' {
        Mock Invoke-CredentialRoute -ModuleName StandardUser { [pscustomobject]@{ ExitCode = 93; TimedOut = $false } }
        Mock Invoke-LogonUserRoute -ModuleName StandardUser { Set-Content -LiteralPath $Context.GroupsFile -Value 'x'; [pscustomobject]@{ ExitCode = 0; TimedOut = $false } }
        $run = Invoke-DesktopRun -Route auto -Context $script:Context
        $run.Route | Should -Be 'logonuser'
        ($script:Log -join "`n") | Should -Match 'Desktop route credential: the child never started as the user \(exit code 93 .*could not record the token'
    }

    It 'reports not started when every route fails' {
        Mock Invoke-CredentialRoute -ModuleName StandardUser { [pscustomobject]@{ ExitCode = 1; TimedOut = $false } }
        Mock Invoke-LogonUserRoute -ModuleName StandardUser { throw 'LogonUserW failed' }
        $run = Invoke-DesktopRun -Route auto -Context $script:Context
        $run.Started | Should -BeFalse
        @($run.Attempts).Count | Should -Be 2
    }

    It 'credential never falls back' {
        Mock Invoke-CredentialRoute -ModuleName StandardUser { [pscustomobject]@{ ExitCode = 1; TimedOut = $false } }
        Mock Invoke-LogonUserRoute -ModuleName StandardUser { throw 'must not run' }
        $run = Invoke-DesktopRun -Route credential -Context $script:Context
        $run.Route | Should -Be 'credential'
        $run.Started | Should -BeFalse
        Should -Invoke Invoke-LogonUserRoute -ModuleName StandardUser -Times 0 -Exactly
    }

    It 'logonuser runs only logonuser' {
        Mock Invoke-CredentialRoute -ModuleName StandardUser { throw 'must not run' }
        Mock Invoke-LogonUserRoute -ModuleName StandardUser { Set-Content -LiteralPath $Context.GroupsFile -Value 'x'; [pscustomobject]@{ ExitCode = 3; TimedOut = $false } }
        $run = Invoke-DesktopRun -Route logonuser -Context $script:Context
        $run.Route | Should -Be 'logonuser'
        $run.ExitCode | Should -Be 3
        Should -Invoke Invoke-CredentialRoute -ModuleName StandardUser -Times 0 -Exactly
    }

    It 'a timeout stops the run and never falls back' {
        Mock Invoke-CredentialRoute -ModuleName StandardUser { [pscustomobject]@{ ExitCode = $null; TimedOut = $true } }
        Mock Invoke-LogonUserRoute -ModuleName StandardUser { throw 'must not run' }
        $run = Invoke-DesktopRun -Route auto -Context $script:Context
        $run.TimedOut | Should -BeTrue
        Should -Invoke Invoke-LogonUserRoute -ModuleName StandardUser -Times 0 -Exactly
    }
}

Describe 'Invoke-BatchRun: the scheduled task with mocked task calls' {
    BeforeEach {
        $script:Context = @{
            Pwsh = 'C:\pwsh\pwsh.exe'; Arguments = @('-File', '"D:\a\_temp\o\wrapper.ps1"'); Workspace = 'D:\a\r'
            AccountName = 'ci000000000000'; Domain = 'HOST'; Password = (Get-TestSecureString); TimeoutMinutes = 1
            GroupsFile = Join-Path $TestDrive 'batch-groups.csv'; TaskName = 'ci-standard-user-ci000000000000'
        }
        Remove-Item -LiteralPath $script:Context.GroupsFile -ErrorAction SilentlyContinue
        $script:Polls = 0
        $script:FinalResult = [uint32] 0
        $script:WritesGroups = $true
        $script:PasswordSeen = $false
        Mock Write-RunnerLog -ModuleName StandardUser { }
        Mock Register-ScheduledTask -ModuleName StandardUser { $script:PasswordSeen = ($Password -ceq $script:TestPassword) }
        Mock Start-ScheduledTask -ModuleName StandardUser { if ($script:WritesGroups) { Set-Content -LiteralPath $script:Context.GroupsFile -Value 'x' } }
        Mock Start-Sleep -ModuleName StandardUser { }
        Mock Stop-ScheduledTask -ModuleName StandardUser { }
        Mock Get-ScheduledTask -ModuleName StandardUser { $script:Polls++; [pscustomobject]@{ State = $(if ($script:Polls -lt 2) { 'Running' } else { 'Ready' }) } }
        Mock Get-ScheduledTaskInfo -ModuleName StandardUser { [pscustomobject]@{ LastTaskResult = $(if ($script:Polls -lt 2) { [uint32] 267009 } else { $script:FinalResult }) } }
    }

    It 'registers the task at Limited with the password, polls until it ends and returns its result' {
        $script:FinalResult = [uint32] 7
        $run = Invoke-BatchRun -Context $script:Context
        $run.Route | Should -Be 'batch'
        $run.Started | Should -BeTrue
        $run.ExitCode | Should -Be 7
        $run.TimedOut | Should -BeFalse
        $script:Polls | Should -Be 2
        $script:PasswordSeen | Should -BeTrue -Because 'Register-ScheduledTask gets the SecureString''s text, and only that call'
        Should -Invoke Register-ScheduledTask -ModuleName StandardUser -Times 1 -Exactly -ParameterFilter { $RunLevel -eq 'Limited' -and $User -eq 'HOST\ci000000000000' -and $TaskName -eq 'ci-standard-user-ci000000000000' }
        Should -Invoke Stop-ScheduledTask -ModuleName StandardUser -Times 0 -Exactly
    }

    It 'sets the task''s ExecutionTimeLimit from the context''s TimeoutMinutes (<Minutes> minutes)' -TestCases @(@{ Minutes = 7; Limit = 'PT7M' }, @{ Minutes = 90; Limit = 'PT1H30M' }) {
        $script:Context.TimeoutMinutes = $Minutes
        $null = Invoke-BatchRun -Context $script:Context
        Should -Invoke Register-ScheduledTask -ModuleName StandardUser -Times 1 -Exactly -ParameterFilter { $Settings.ExecutionTimeLimit -eq $Limit }
    }

    It 'turns an HRESULT result into a negative exit code, and without a groups file the child did not start' {
        $script:FinalResult = [uint32] 2147943727 # 0x8007052F, logon failure
        $script:WritesGroups = $false
        $run = Invoke-BatchRun -Context $script:Context
        $run.ExitCode | Should -Be -2147023569
        $run.Started | Should -BeFalse
    }

    It 'stops a task still running at the deadline and reports a timeout' {
        Mock Get-ScheduledTask -ModuleName StandardUser { [pscustomobject]@{ State = 'Running' } }
        Mock Get-ScheduledTaskInfo -ModuleName StandardUser { [pscustomobject]@{ LastTaskResult = [uint32] 267009 } }
        $script:Clock = [datetime]::new(2026, 1, 1)
        Mock Get-Date -ModuleName StandardUser { $script:Clock = $script:Clock.AddMinutes(5); $script:Clock }
        $run = Invoke-BatchRun -Context $script:Context
        $run.TimedOut | Should -BeTrue
        $run.ExitCode | Should -BeNullOrEmpty
        Should -Invoke Stop-ScheduledTask -ModuleName StandardUser -Times 1 -Exactly
    }

    It 'Test-TaskRunning: <State> with <Result> is running: <Running>' -TestCases @(
        @{ State = 'Running'; Result = 0; Running = $true }
        @{ State = 'Queued'; Result = 0; Running = $true }
        @{ State = 'Ready'; Result = 267009; Running = $true }
        @{ State = 'Ready'; Result = 267011; Running = $true }
        @{ State = 'Ready'; Result = 0; Running = $false }
        @{ State = 'Ready'; Result = 2147943727; Running = $false }
    ) {
        Test-TaskRunning -State $State -Result ([uint32] $Result) | Should -Be $Running
    }

    It 'ConvertFrom-TaskResult: <Result> is <Code>' -TestCases @(
        @{ Result = 0; Code = 0 }
        @{ Result = 1; Code = 1 }
        @{ Result = 2147483647; Code = 2147483647 }
        @{ Result = 2147943727; Code = -2147023569 }
        @{ Result = 4294967295; Code = -1 }
    ) {
        ConvertFrom-TaskResult -Result ([uint32] $Result) | Should -Be $Code
    }
}

Describe 'Invoke-CredentialRoute: Start-Process -Credential, with a stand-in process' {
    BeforeEach {
        $script:Context = @{
            Pwsh = 'C:\pwsh\pwsh.exe'; Arguments = @('-NoProfile', '-File', '"D:\a\_temp\o\wrapper.ps1"'); Workspace = 'D:\a\r'
            AccountName = 'ci000000000000'; Domain = 'HOST'; Password = (Get-TestSecureString); TimeoutMinutes = 7
        }
        $script:Waited = $null
        $script:Killed = $null
        $script:Disposed = $false
        $script:Ends = $true
        Mock Write-RunnerLog -ModuleName StandardUser { }
        # Nothing is started: the stand-in answers the calls the route makes on a process.
        Mock Start-Process -ModuleName StandardUser {
            $process = [pscustomobject]@{ Id = 4242; Handle = [IntPtr] 1; ExitCode = 5; HasExited = $false }
            $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param([int] $Milliseconds) $script:Waited = $Milliseconds; $script:Ends }
            $process | Add-Member -MemberType ScriptMethod -Name Kill -Value { param([bool] $EntireProcessTree) $script:Killed = $EntireProcessTree }
            $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:Disposed = $true }
            $process
        }
    }

    It 'starts the child as DOMAIN\account with its profile loaded, hidden, in the workspace, and waits TimeoutMinutes' {
        $run = Invoke-CredentialRoute -Context $script:Context
        $run.ExitCode | Should -Be 5
        $run.TimedOut | Should -BeFalse
        $script:Waited | Should -Be (7 * 60000)
        $script:Killed | Should -BeNullOrEmpty
        $script:Disposed | Should -BeTrue
        Should -Invoke Start-Process -ModuleName StandardUser -Times 1 -Exactly -ParameterFilter {
            $Credential.UserName -eq 'HOST\ci000000000000' -and $LoadUserProfile.IsPresent -and $PassThru.IsPresent -and
            $FilePath -eq 'C:\pwsh\pwsh.exe' -and $WorkingDirectory -eq 'D:\a\r' -and "$WindowStyle" -eq 'Hidden' -and
            (@($ArgumentList) -join ' ') -eq '-NoProfile -File "D:\a\_temp\o\wrapper.ps1"'
        }
    }

    It 'stops the child''s whole process tree and reports a timeout when it runs past TimeoutMinutes' {
        $script:Ends = $false
        $run = Invoke-CredentialRoute -Context $script:Context
        $run.TimedOut | Should -BeTrue
        $run.ExitCode | Should -BeNullOrEmpty
        $script:Killed | Should -BeTrue
        $script:Disposed | Should -BeTrue
    }
}

Describe 'The readers the runner proof uses after the cleanup (they only read)' {
    BeforeAll {
        function ConvertTo-BinaryDescriptor([string] $Sddl) {
            $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
            $bytes = [byte[]]::new($descriptor.BinaryLength)
            $descriptor.GetBinaryForm($bytes, 0)
            , $bytes
        }
        function Get-FirstAceSid([byte[]] $Bytes) {
            $acl = [System.Security.AccessControl.RawSecurityDescriptor]::new($Bytes, 0).DiscretionaryAcl
            @($acl | Where-Object { $_ -is [System.Security.AccessControl.KnownAce] })[0].SecurityIdentifier.Value
        }
        # A SID no account on any machine has: a random domain part.
        $script:FreshSid = 'S-1-5-21-' + ((1..3 | ForEach-Object { [System.Security.Cryptography.RandomNumberGenerator]::GetInt32(1, [int]::MaxValue) }) -join '-') + '-1001'
    }

    It 'Measure-SUAceForSid counts every DACL entry that names the SID, allow and deny, and no other' {
        $bytes = ConvertTo-BinaryDescriptor 'D:(A;;GA;;;S-1-5-21-1-2-3-1001)(A;;GR;;;S-1-5-21-1-2-3-1001)(D;;GW;;;S-1-5-21-1-2-3-1001)(A;;GA;;;SY)'
        Measure-SUAceForSid -SecurityDescriptor $bytes -Sid 'S-1-5-21-1-2-3-1001' | Should -Be 3
        Measure-SUAceForSid -SecurityDescriptor $bytes -Sid 'S-1-5-18' | Should -Be 1
        Measure-SUAceForSid -SecurityDescriptor $bytes -Sid 'S-1-5-21-1-2-3-1002' | Should -Be 0
    }

    It 'Measure-SUAceForSid counts nothing in a descriptor without a DACL' {
        Measure-SUAceForSid -SecurityDescriptor (ConvertTo-BinaryDescriptor 'O:SY') -Sid 'S-1-5-18' | Should -Be 0
    }

    It 'Get-SUStationEntry reads this session''s window station and desktop: an entry they hold counts, a fresh SID does not' {
        Initialize-StandardUserNative
        $descriptors = [StandardUserNative]::ReadStationSecurity()
        $descriptors.Count | Should -Be 2
        $onStation = Get-FirstAceSid $descriptors[0]
        $onDesktop = Get-FirstAceSid $descriptors[1]
        (Get-SUStationEntry -Sid $onStation).StationEntries | Should -BeGreaterThan 0 -Because "$onStation has an entry on the window station"
        (Get-SUStationEntry -Sid $onDesktop).DesktopEntries | Should -BeGreaterThan 0 -Because "$onDesktop has an entry on the desktop"
        $fresh = Get-SUStationEntry -Sid $script:FreshSid
        $fresh.StationEntries | Should -Be 0
        $fresh.DesktopEntries | Should -Be 0
        $fresh.Desktop | Should -Match '^[^\\]+\\[^\\]+$'
        $fresh.SessionId | Should -Be ([System.Diagnostics.Process]::GetCurrentProcess().SessionId)
    }

    It 'ReadStationSecurity returns the window station''s DACL as [0] and the desktop''s as [1], as a separate read of each gives them' {
        # The oracle reads each object through GetUserObjectSecurity, not the module's
        # GetSecurityInfo, and only reads. Where the two DACLs are the same, swapping them
        # changes nothing the runner proof checks.
        if (-not ('StandardUserTestOracle' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class StandardUserTestOracle {
    const uint READ_CONTROL = 0x00020000;
    const uint DACL_SECURITY_INFORMATION = 0x00000004;
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenWindowStationW(string name, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseWindowStation(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetUserObjectSecurity(IntPtr handle, ref uint requested, byte[] descriptor, uint length, out uint needed);
    static byte[] Read(IntPtr handle) {
        uint requested = DACL_SECURITY_INFORMATION, needed;
        GetUserObjectSecurity(handle, ref requested, null, 0, out needed);
        if (needed == 0) throw new Win32Exception();
        var bytes = new byte[needed];
        if (!GetUserObjectSecurity(handle, ref requested, bytes, needed, out needed)) throw new Win32Exception();
        return bytes;
    }
    public static byte[] Station(string name) {
        IntPtr handle = OpenWindowStationW(name, false, READ_CONTROL);
        if (handle == IntPtr.Zero) throw new Win32Exception();
        try { return Read(handle); } finally { CloseWindowStation(handle); }
    }
    public static byte[] Desktop(string name) {
        IntPtr handle = OpenDesktopW(name, 0, false, READ_CONTROL);
        if (handle == IntPtr.Zero) throw new Win32Exception();
        try { return Read(handle); } finally { CloseDesktop(handle); }
    }
}
'@
        }
        Initialize-StandardUserNative
        $station, $desktop = [StandardUserNative]::StationDesktopName() -split '\\', 2
        $descriptors = [StandardUserNative]::ReadStationSecurity()
        $descriptors.Count | Should -Be 2
        $dacl = { param([byte[]] $Bytes) [System.Security.AccessControl.RawSecurityDescriptor]::new($Bytes, 0).GetSddlForm('Access') }
        & $dacl $descriptors[0] | Should -Be (& $dacl ([StandardUserTestOracle]::Station($station))) -Because "[0] is the DACL of the window station $station"
        & $dacl $descriptors[1] | Should -Be (& $dacl ([StandardUserTestOracle]::Desktop($desktop))) -Because "[1] is the DACL of the desktop $desktop"
    }

    It 'Get-SUStationEntry counts each SID''s entries on the window station from [0] and on the desktop from [1]' {
        # Every SID either DACL names; where a SID has a different number of entries on the
        # two objects, a count taken from the wrong one shows.
        Initialize-StandardUserNative
        $descriptors = [StandardUserNative]::ReadStationSecurity()
        $sids = @(foreach ($descriptor in $descriptors) {
                [System.Security.AccessControl.RawSecurityDescriptor]::new($descriptor, 0).DiscretionaryAcl |
                    Where-Object { $_ -is [System.Security.AccessControl.KnownAce] } | ForEach-Object { $_.SecurityIdentifier.Value }
            }) | Sort-Object -Unique
        @($sids).Count | Should -BeGreaterThan 0
        foreach ($sid in $sids) {
            $entry = Get-SUStationEntry -Sid $sid
            "$sid station $($entry.StationEntries) desktop $($entry.DesktopEntries)" |
                Should -Be "$sid station $(Measure-SUAceForSid -SecurityDescriptor $descriptors[0] -Sid $sid) desktop $(Measure-SUAceForSid -SecurityDescriptor $descriptors[1] -Sid $sid)"
        }
    }

    It 'Get-SUAccountRight finds no right for a SID without an LSA account object' {
        @(Get-SUAccountRight -Sid $script:FreshSid).Count | Should -Be 0
    }

    It 'Get-SUAccountRight never reads a failure as "no rights": Users has rights, or the read throws access denied' {
        # Elevated (the runner) it reads Users' rights; unelevated, LSA refuses (measured:
        # 0xC0000022), and the reader must throw rather than say "none".
        $rights = $null
        $failure = $null
        try { $rights = @(Get-SUAccountRight -Sid 'S-1-5-32-545') } catch { $failure = $_.Exception }
        if ($failure) {
            while ($failure -and $failure -isnot [System.ComponentModel.Win32Exception]) { $failure = $failure.InnerException }
            $failure | Should -Not -BeNullOrEmpty -Because 'the read failed with a Win32 error'
            $failure.NativeErrorCode | Should -Be 5
        } else {
            $rights.Count | Should -BeGreaterThan 0
            $rights | ForEach-Object { $_ | Should -Match '^Se[A-Za-z]+(Privilege|Right)$' }
        }
    }
}

Describe 'Invoke-StandardUserRun: the whole step, with every side effect mocked' {
    BeforeAll {
        $script:Sid = 'S-1-5-21-1-2-3-1001'
        function Write-TestChild([hashtable] $Context) {
            if (-not $script:Child.Started) { return }
            Set-Content -LiteralPath $Context.UserFile -Value ('"HOST\' + $Context.AccountName + '","' + $script:Child.UserSid + '"') -Encoding utf8
            Set-Content -LiteralPath $Context.GroupsFile -Value (Read-Fixture $script:Child.Groups) -Encoding utf8 -NoNewline
        }
        function Invoke-TestRun([string] $Token = 'desktop', [string] $DesktopRoute = 'auto', [int] $TimeoutMinutes = 0) {
            # -TimeoutMinutes is passed only when a test gives it, so the other tests run on the default.
            $extra = @{}
            if ($TimeoutMinutes) { $extra.TimeoutMinutes = $TimeoutMinutes }
            Invoke-StandardUserRun -Script 'probe.ps1' -Token $Token -DesktopRoute $DesktopRoute -Workspace $script:Workspace -RunnerTemp $script:Temp -Pwsh 'C:\pwsh\pwsh.exe' @extra
        }
        function Get-TestOutDir {
            @(Get-ChildItem -LiteralPath $script:Temp -Directory -Filter 'standard-user-*')[0].FullName
        }
    }

    BeforeEach {
        $script:Temp = (New-Item -ItemType Directory -Path (Join-Path $TestDrive ('t' + [guid]::NewGuid().ToString('N').Substring(0, 8))) -Force).FullName
        $script:Workspace = (New-Item -ItemType Directory -Path (Join-Path $script:Temp 'workspace') -Force).FullName
        Set-Content -LiteralPath (Join-Path $script:Workspace 'probe.ps1') -Value 'exit 0'
        $script:SavedOutput = $env:GITHUB_OUTPUT
        $env:GITHUB_OUTPUT = Join-Path $script:Temp 'github-output.txt'
        $script:Log = [System.Collections.Generic.List[string]]::new()
        $script:CleanupCalls = 0
        $script:CleanupKinds = $null
        $script:CleanupAccount = $null
        $script:CleanupResult = @()
        $script:Child = @{ Groups = 'standard-desktop.csv'; UserSid = $script:Sid; ExitCode = 0; Started = $true; Route = 'credential'; TimedOut = $false }
        Mock Write-RunnerLog -ModuleName StandardUser { $script:Log.Add($Text) }
        Mock Get-RunnerGroupsText -ModuleName StandardUser { Read-Fixture 'filtered-admin-session.csv' }
        Mock New-StandardUserPassword -ModuleName StandardUser { Get-TestSecureString }
        Mock Find-SULocalUser -ModuleName StandardUser { }
        $script:CreatedName = $null
        Mock New-LocalUser -ModuleName StandardUser { $script:CreatedName = $Name; [pscustomobject]@{ Name = $Name; SID = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-1001') } }
        Mock Add-LocalGroupMember -ModuleName StandardUser { }
        Mock Grant-SUFolderAccess -ModuleName StandardUser { }
        Mock Get-Service -ModuleName StandardUser { [pscustomobject]@{ Status = 'Running'; StartType = 'Manual' } }
        Mock Start-Service -ModuleName StandardUser { }
        Mock Grant-SUStationAccess -ModuleName StandardUser { 'WinSta0\Default' }
        Mock Grant-SUBatchRight -ModuleName StandardUser { }
        Mock Invoke-StandardUserCleanup -ModuleName StandardUser {
            $script:CleanupCalls++
            $script:CleanupKinds = @($State | ForEach-Object { $_.Kind })
            $script:CleanupAccount = @($State | Where-Object { $_.Kind -eq 'account' } | ForEach-Object { $_.Data })
            $script:CleanupResult
        }
        Mock Invoke-DesktopRun -ModuleName StandardUser {
            Write-TestChild -Context $Context
            [pscustomobject]@{ Route = $script:Child.Route; Started = $script:Child.Started; ExitCode = $script:Child.ExitCode; TimedOut = $script:Child.TimedOut; Attempts = @() }
        }
        Mock Invoke-BatchRun -ModuleName StandardUser {
            Write-TestChild -Context $Context
            [pscustomobject]@{ Route = 'batch'; Started = $script:Child.Started; ExitCode = $script:Child.ExitCode; TimedOut = $script:Child.TimedOut; Attempts = @() }
        }
    }

    AfterEach {
        if ($null -eq $script:SavedOutput) { Remove-Item Env:\GITHUB_OUTPUT -ErrorAction SilentlyContinue } else { $env:GITHUB_OUTPUT = $script:SavedOutput }
    }

    It 'returns the script''s own exit code <Code> for a desktop run that passes the check' -TestCases @(@{ Code = 0 }, @{ Code = 7 }) {
        $script:Child.ExitCode = $Code
        $result = @(Invoke-TestRun)
        $result.Count | Should -Be 1 -Because 'nothing but the exit code leaves the function'
        $result[0] | Should -BeOfType [int]
        $result[0] | Should -Be $Code
        $script:Log | Should -Contain 'Route that ran: credential.'
    }

    It 'returns the script''s own exit code <Code> for a batch run that passes the check' -TestCases @(@{ Code = 0 }, @{ Code = 3 }) {
        $script:Child.Groups = 'standard-batch.csv'
        $script:Child.ExitCode = $Code
        Invoke-TestRun -Token batch | Should -Be $Code
        Should -Invoke Invoke-BatchRun -ModuleName StandardUser -Times 1 -Exactly
        Should -Invoke Invoke-DesktopRun -ModuleName StandardUser -Times 0 -Exactly
        Should -Invoke Grant-SUBatchRight -ModuleName StandardUser -Times 1 -Exactly
        Should -Invoke Grant-SUStationAccess -ModuleName StandardUser -Times 0 -Exactly
    }

    It 'judges the child by the kind requested: <Groups> under a <Token> run gives 90' -TestCases @(
        @{ Token = 'desktop'; Groups = 'standard-batch.csv' }
        @{ Token = 'batch'; Groups = 'standard-desktop.csv' }
        @{ Token = 'desktop'; Groups = 'filtered-admin-session.csv' }
        @{ Token = 'batch'; Groups = 'admin-deny-only.csv' }
    ) {
        $script:Child.Groups = $Groups
        Invoke-TestRun -Token $Token | Should -Be 90
    }

    It 'gives 90 when the child''s token belongs to another account' {
        $script:Child.UserSid = 'S-1-5-21-1-2-3-1002'
        Invoke-TestRun | Should -Be 90
        ($script:Log -join "`n") | Should -Match 'not to the account this run created'
    }

    It 'gives 92 when the child never started' {
        $script:Child.Started = $false
        $script:Child.ExitCode = 93
        Invoke-TestRun | Should -Be 92
    }

    It 'stops with 91 before creating anything when the self-test <Why>' -TestCases @(
        @{ Why = 'passes the runner''s token'; Runner = 'standard-desktop.csv' }
        @{ Why = 'fails the runner''s token for the kind only'; Runner = 'standard-batch.csv' }
    ) {
        Mock Get-RunnerGroupsText -ModuleName StandardUser { Read-Fixture $Runner }
        Invoke-TestRun | Should -Be 91
        Should -Invoke New-StandardUserPassword -ModuleName StandardUser -Times 0 -Exactly
        Should -Invoke New-LocalUser -ModuleName StandardUser -Times 0 -Exactly
        Should -Invoke Invoke-DesktopRun -ModuleName StandardUser -Times 0 -Exactly
        Should -Invoke Invoke-StandardUserCleanup -ModuleName StandardUser -Times 0 -Exactly
        $script:Log[0] | Should -BeLike '::error::*(exit 91)*'
    }

    It 'logs the self-test line first when the self-test holds' {
        $null = Invoke-TestRun
        $script:Log[0] | Should -BeLike "Self-test: the runner's own token fails the check as it must (*"
    }

    It 'masks the password: New-StandardUserPassword is called with -EmitMask, once' {
        $null = Invoke-TestRun
        Should -Invoke New-StandardUserPassword -ModuleName StandardUser -Times 1 -Exactly -ParameterFilter { $EmitMask.IsPresent }
    }

    It 'never writes the password to the log, the step outputs, the wrapper or the result' {
        $null = Invoke-TestRun
        $out = @(Get-ChildItem -LiteralPath $script:Temp -Directory -Filter 'standard-user-*')[0].FullName
        $texts = @($script:Log) + @(Get-Content -LiteralPath $env:GITHUB_OUTPUT -Raw) + @(Get-ChildItem -LiteralPath $out -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw })
        @($texts | Where-Object { $_ -and $_.Contains($script:TestPassword) }).Count | Should -Be 0
    }

    It 'passes desktop-route <Route> on to the desktop run' -TestCases @(@{ Route = 'credential' }, @{ Route = 'logonuser' }, @{ Route = 'auto' }) {
        $null = Invoke-TestRun -DesktopRoute $Route
        # Inside the filter $Route is the mock's own -Route, so the expected value carries
        # another name; `$Route -eq $Route` would compare the mock's value with itself.
        $expectedRoute = $Route
        Should -Invoke Invoke-DesktopRun -ModuleName StandardUser -Times 1 -Exactly -ParameterFilter { $Route -eq $expectedRoute }
    }

    It 'creates the account with a name and description New-LocalUser accepts (its mock keeps the real validation)' {
        $null = Invoke-TestRun
        Should -Invoke New-LocalUser -ModuleName StandardUser -Times 1 -Exactly -ParameterFilter { $Name -match '^ci[0-9a-f]{12}$' -and $Description.Length -le 48 }
    }

    It 'makes the account a member of Users (S-1-5-32-545) and of no other group (<Token> token)' -TestCases @(@{ Token = 'desktop'; Groups = 'standard-desktop.csv' }, @{ Token = 'batch'; Groups = 'standard-batch.csv' }) {
        # action.yml and the run script's header promise "member of Users (S-1-5-32-545) only".
        $script:Child.Groups = $Groups
        $null = Invoke-TestRun -Token $Token
        $created = $script:CreatedName
        $created | Should -Match '^ci[0-9a-f]{12}$'
        Should -Invoke Add-LocalGroupMember -ModuleName StandardUser -Times 1 -Exactly
        Should -Invoke Add-LocalGroupMember -ModuleName StandardUser -Times 1 -Exactly -ParameterFilter { "$SID" -eq 'S-1-5-32-545' -and "$Member" -eq $created }
    }

    It 'grants the workspace ReadAndExecute and only the output folder Modify (<Token> token)' -TestCases @(@{ Token = 'desktop'; Groups = 'standard-desktop.csv' }, @{ Token = 'batch'; Groups = 'standard-batch.csv' }) {
        # action.yml's script input promises read access to the workspace and write access
        # to $env:STANDARD_USER_OUT, and nothing else.
        $script:Child.Groups = $Groups
        $null = Invoke-TestRun -Token $Token
        # The filters see the mock's own parameters ($Path, $Sid, $Rights), so the expected
        # values carry names that differ from them.
        $workspace = $script:Workspace
        $outDir = Get-TestOutDir
        $accountSid = $script:Sid
        Should -Invoke Grant-SUFolderAccess -ModuleName StandardUser -Times 2 -Exactly
        Should -Invoke Grant-SUFolderAccess -ModuleName StandardUser -Times 1 -Exactly -ParameterFilter { $Path -eq $workspace -and $Rights -eq 'ReadAndExecute' -and $Sid -eq $accountSid }
        Should -Invoke Grant-SUFolderAccess -ModuleName StandardUser -Times 1 -Exactly -ParameterFilter { $Path -eq $outDir -and $Rights -eq 'Modify' -and $Sid -eq $accountSid }
    }

    It 'carries -TimeoutMinutes 7 into the <Token> route''s context' -TestCases @(
        @{ Token = 'desktop'; Groups = 'standard-desktop.csv'; Route = 'Invoke-DesktopRun' }
        @{ Token = 'batch'; Groups = 'standard-batch.csv'; Route = 'Invoke-BatchRun' }
    ) {
        # The routes take the time limit from the context alone: Invoke-BatchRun turns it into
        # the task's ExecutionTimeLimit (tested with Invoke-BatchRun), the desktop routes into
        # their wait.
        $script:Child.Groups = $Groups
        Invoke-TestRun -Token $Token -TimeoutMinutes 7 | Should -Be 0
        Should -Invoke $Route -ModuleName StandardUser -Times 1 -Exactly -ParameterFilter { $Context.TimeoutMinutes -eq 7 }
    }

    It 'names a -TimeoutMinutes of 7 when the script runs too long' {
        $script:Child.TimedOut = $true
        { Invoke-TestRun -TimeoutMinutes 7 } | Should -Throw '*ran longer than 7 minutes*'
    }

    It 'records in cleanup.json the account''s SID, the desktop it was granted and the session (<Token> token)' -TestCases @(
        @{ Token = 'desktop'; Groups = 'standard-desktop.csv'; Desktop = 'WinSta0\Default' }
        @{ Token = 'batch'; Groups = 'standard-batch.csv'; Desktop = '' }
    ) {
        # The runner proof reads these to check, after the cleanup, that no window-station,
        # desktop or LSA entry for the account is left.
        $script:Child.Groups = $Groups
        $null = Invoke-TestRun -Token $Token
        $cleanup = Get-Content -LiteralPath (Join-Path (Get-TestOutDir) 'cleanup.json') -Raw | ConvertFrom-Json
        $cleanup.accountSid | Should -Be $script:Sid
        $cleanup.desktop | Should -Be $Desktop
        $cleanup.sessionId | Should -Be ([System.Diagnostics.Process]::GetCurrentProcess().SessionId)
    }

    It 'records the account''s SID in cleanup.json even when the run fails after creating it' {
        Mock Grant-SUStationAccess -ModuleName StandardUser { throw 'planted failure' }
        { Invoke-TestRun } | Should -Throw '*planted failure*'
        $cleanup = Get-Content -LiteralPath (Join-Path (Get-TestOutDir) 'cleanup.json') -Raw | ConvertFrom-Json
        $cleanup.accountSid | Should -Be $script:Sid
        $cleanup.desktop | Should -Be ''
    }

    It 'records the account by name before New-LocalUser runs, so a failed creation is still cleaned up' {
        Mock New-LocalUser -ModuleName StandardUser { throw 'created, then failed to set a property' }
        { Invoke-TestRun } | Should -Throw '*failed to set a property*'
        $script:CleanupCalls | Should -Be 1
        $script:CleanupKinds | Should -Be @('account')
        $script:CleanupAccount[0].Name | Should -Match '^ci[0-9a-f]{12}$'
        $script:CleanupAccount[0].Sid | Should -Be ''
    }

    It 'adds the SID to the account record once New-LocalUser returns' {
        $null = Invoke-TestRun
        $script:CleanupAccount[0].Sid | Should -Be $script:Sid
    }

    It 'changes nothing when an account of the chosen name exists already' {
        Mock Find-SULocalUser -ModuleName StandardUser { [pscustomobject]@{ Name = $Name } }
        { Invoke-TestRun } | Should -Throw '*exists already*'
        Should -Invoke New-LocalUser -ModuleName StandardUser -Times 0 -Exactly
        @($script:CleanupKinds).Count | Should -Be 0
    }

    It 'records every item of a desktop run, in order of creation' {
        $null = Invoke-TestRun
        $script:CleanupKinds | Should -Be @('account', 'folder-access', 'folder-access', 'station-grant', 'profile')
        Should -Invoke Start-Service -ModuleName StandardUser -Times 0 -Exactly
    }

    It 'records seclogon when the run starts it' {
        Mock Get-Service -ModuleName StandardUser { [pscustomobject]@{ Status = 'Stopped'; StartType = 'Manual' } }
        $null = Invoke-TestRun
        $script:CleanupKinds | Should -Be @('account', 'folder-access', 'folder-access', 'seclogon', 'station-grant', 'profile')
        Should -Invoke Start-Service -ModuleName StandardUser -Times 1 -Exactly
    }

    It 'records every item of a batch run, in order of creation' {
        $script:Child.Groups = 'standard-batch.csv'
        $null = Invoke-TestRun -Token batch
        $script:CleanupKinds | Should -Be @('account', 'folder-access', 'folder-access', 'batch-right', 'task', 'profile')
    }

    It 'records an item before creating it: <Fails> throws, and its item is already recorded' -TestCases @(
        @{ Fails = 'Grant-SUFolderAccess'; Token = 'desktop'; Last = 'folder-access' }
        @{ Fails = 'Grant-SUStationAccess'; Token = 'desktop'; Last = 'station-grant' }
        @{ Fails = 'Grant-SUBatchRight'; Token = 'batch'; Last = 'batch-right' }
        @{ Fails = 'Invoke-BatchRun'; Token = 'batch'; Last = 'profile' }
    ) {
        Mock $Fails -ModuleName StandardUser { throw 'planted failure' }
        { Invoke-TestRun -Token $Token } | Should -Throw '*planted failure*'
        $script:CleanupCalls | Should -Be 1
        $script:CleanupKinds[-1] | Should -Be $Last
    }

    It 'cleans up and fails the step when the script runs too long' {
        $script:Child.TimedOut = $true
        { Invoke-TestRun } | Should -Throw '*ran longer than 30 minutes*'
        $script:CleanupCalls | Should -Be 1
    }

    It 'writes the step outputs out-dir and route' {
        $script:Child.Route = 'logonuser'
        $null = Invoke-TestRun -DesktopRoute logonuser
        $lines = Get-Content -LiteralPath $env:GITHUB_OUTPUT
        @($lines | Where-Object { $_ -like 'out-dir=*standard-user-ci*' }).Count | Should -Be 1
        $lines | Should -Contain 'route=logonuser'
    }

    It 'writes result.json and cleanup.json into the output folder' {
        $script:Child.ExitCode = 1
        $null = Invoke-TestRun
        $out = @(Get-ChildItem -LiteralPath $script:Temp -Directory -Filter 'standard-user-*')[0].FullName
        $result = Get-Content -LiteralPath (Join-Path $out 'result.json') -Raw | ConvertFrom-Json
        $result.exitCode | Should -Be 1
        $result.scriptExitCode | Should -Be 1
        $result.contextCheck | Should -Be 'passed'
        $result.route | Should -Be 'credential'
        $result.selfTest | Should -Contain 'administrators'
        $cleanup = Get-Content -LiteralPath (Join-Path $out 'cleanup.json') -Raw | ConvertFrom-Json
        @($cleanup.failures).Count | Should -Be 0
    }

    It 'warns about, and records, a cleanup step that failed' {
        $script:CleanupResult = @('task: the task could not be unregistered')
        $null = Invoke-TestRun
        $script:Log | Should -Contain '::warning::cleanup step not done: task: the task could not be unregistered'
        $out = @(Get-ChildItem -LiteralPath $script:Temp -Directory -Filter 'standard-user-*')[0].FullName
        @((Get-Content -LiteralPath (Join-Path $out 'cleanup.json') -Raw | ConvertFrom-Json).failures) | Should -Be @('task: the task could not be unregistered')
    }

    It 'writes a wrapper that parses and runs the script from the workspace' {
        $null = Invoke-TestRun
        $out = @(Get-ChildItem -LiteralPath $script:Temp -Directory -Filter 'standard-user-*')[0].FullName
        $errors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $out 'wrapper.ps1'), [ref] $null, [ref] $errors)
        @($errors).Count | Should -Be 0
        Get-Content -LiteralPath (Join-Path $out 'wrapper.ps1') -Raw | Should -Match ([regex]::Escape((Join-Path $script:Workspace 'probe.ps1')))
    }
}

Describe 'Invoke-StandardUserCleanup: reverse order, idempotent, never stops early' {
    BeforeEach {
        $script:Calls = [System.Collections.Generic.List[string]]::new()
        Mock Remove-SUAccount -ModuleName StandardUser { $script:Calls.Add('account') }
        Mock Remove-SUFolderAccess -ModuleName StandardUser { $script:Calls.Add("folder-access:$Path") }
        Mock Stop-SUSecondaryLogon -ModuleName StandardUser { $script:Calls.Add('seclogon') }
        Mock Remove-SUStationGrant -ModuleName StandardUser { $script:Calls.Add('station-grant') }
        Mock Remove-SUBatchRight -ModuleName StandardUser { $script:Calls.Add('batch-right') }
        Mock Remove-SUScheduledTask -ModuleName StandardUser { $script:Calls.Add('task') }
        Mock Remove-SUProfile -ModuleName StandardUser { $script:Calls.Add('profile') }
        $script:State = [System.Collections.Generic.List[object]]::new()
        $sid = 'S-1-5-21-1-2-3-1001'
        Add-StandardUserItem -State $script:State -Kind account -Data @{ Name = 'ci000000000000'; Sid = $sid }
        Add-StandardUserItem -State $script:State -Kind folder-access -Data @{ Path = 'out'; Sid = $sid }
        Add-StandardUserItem -State $script:State -Kind folder-access -Data @{ Path = 'workspace'; Sid = $sid }
    }

    It 'undoes a desktop run in reverse order of creation' {
        Add-StandardUserItem -State $script:State -Kind seclogon -Data @{}
        Add-StandardUserItem -State $script:State -Kind station-grant -Data @{ SidBytes = [byte[]](1, 2) }
        Add-StandardUserItem -State $script:State -Kind profile -Data @{ Sid = 'S-1-5-21-1-2-3-1001' }
        $failures = @(Invoke-StandardUserCleanup -State $script:State)
        $failures.Count | Should -Be 0
        @($script:Calls) | Should -Be @('profile', 'station-grant', 'seclogon', 'folder-access:workspace', 'folder-access:out', 'account')
        $script:State.Count | Should -Be 0
    }

    It 'undoes a batch run in reverse order of creation' {
        Add-StandardUserItem -State $script:State -Kind batch-right -Data @{ SidBytes = [byte[]](1, 2) }
        Add-StandardUserItem -State $script:State -Kind task -Data @{ TaskName = 'ci-standard-user-ci000000000000' }
        Add-StandardUserItem -State $script:State -Kind profile -Data @{ Sid = 'S-1-5-21-1-2-3-1001' }
        $null = Invoke-StandardUserCleanup -State $script:State
        @($script:Calls) | Should -Be @('profile', 'task', 'batch-right', 'folder-access:workspace', 'folder-access:out', 'account')
    }

    It 'keeps going when one step throws, reports it, and keeps only that step for a retry' {
        Mock Remove-SUFolderAccess -ModuleName StandardUser { $script:Calls.Add("folder-access:$Path"); if ($Path -eq 'workspace') { throw 'access denied' } }
        $failures = @(Invoke-StandardUserCleanup -State $script:State)
        @($script:Calls) | Should -Be @('folder-access:workspace', 'folder-access:out', 'account')
        $failures.Count | Should -Be 1
        $failures[0] | Should -Match 'folder-access'
        $script:State.Count | Should -Be 1
        $script:State[0].Data.Path | Should -Be 'workspace'
    }

    It 'counts a step that writes an error, without throwing, as failed' {
        Mock Remove-SUAccount -ModuleName StandardUser { Write-Error 'Remove-LocalUser: access denied' }
        $failures = @(Invoke-StandardUserCleanup -State $script:State)
        $failures.Count | Should -Be 1
        $failures[0] | Should -BeLike 'account: *access denied*'
        $script:State.Count | Should -Be 1
        $script:State[0].Kind | Should -Be 'account'
    }

    It 'is idempotent: a second call after a clean run does nothing' {
        $null = Invoke-StandardUserCleanup -State $script:State
        $script:Calls.Clear()
        $failures = @(Invoke-StandardUserCleanup -State $script:State)
        $script:Calls.Count | Should -Be 0
        $failures.Count | Should -Be 0
    }

    It 'rejects an unknown kind' {
        { Add-StandardUserItem -State $script:State -Kind 'registry' -Data @{} } | Should -Throw -ErrorId 'ParameterArgumentValidationError*'
    }

    It 'returns the record with -PassThru, and only then' {
        $item = Add-StandardUserItem -State $script:State -Kind profile -Data @{ Sid = 'S-1-5-21-1-2-3-1001' } -PassThru
        $item.Kind | Should -Be 'profile'
        [object]::ReferenceEquals($item, $script:State[-1]) | Should -BeTrue
        Add-StandardUserItem -State $script:State -Kind profile -Data @{ Sid = 'S-1-5-21-1-2-3-1001' } | Should -BeNullOrEmpty
    }

    It 'the module stops on every error inside it (its own preference, not the caller''s)' {
        & (Get-Module StandardUser) { $ErrorActionPreference } | Should -Be 'Stop'
    }
}

Describe 'The real removers do nothing when there is nothing to remove' {
    It 'Find-SULocalUser returns nothing for an account that does not exist, and writes no error' {
        $streams = @(Find-SULocalUser -Name (New-StandardUserName) 2>&1)
        $streams.Count | Should -Be 0 -Because 'the module''s Stop preference turns "user not found" into the error it catches, so nothing reaches the error stream'
    }

    It 'Find-SULocalUser passes on any other error' {
        Mock Get-LocalUser -ModuleName StandardUser { throw [System.UnauthorizedAccessException]::new('Access is denied.') }
        { Find-SULocalUser -Name 'ci000000000000' } | Should -Throw '*Access is denied*'
    }

    It 'Remove-SUAccount leaves a missing account alone' {
        Mock Remove-LocalUser -ModuleName StandardUser { throw 'must not run' }
        Mock Find-SULocalUser -ModuleName StandardUser { }
        { Remove-SUAccount -Name 'ci000000000000' -Sid 'S-1-5-21-1-2-3-1001' } | Should -Not -Throw
        Should -Invoke Remove-LocalUser -ModuleName StandardUser -Times 0 -Exactly
    }

    It 'Remove-SUAccount refuses an account whose SID is not the one it created' {
        Mock Remove-LocalUser -ModuleName StandardUser { }
        Mock Find-SULocalUser -ModuleName StandardUser { [pscustomobject]@{ Name = 'ci000000000000'; SID = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-21-9-9-9-500') } }
        { Remove-SUAccount -Name 'ci000000000000' -Sid 'S-1-5-21-1-2-3-1001' } | Should -Throw -ExpectedMessage '*not the account this run created*'
        Should -Invoke Remove-LocalUser -ModuleName StandardUser -Times 0 -Exactly
    }

    It 'Remove-SUAccount removes the account it created' {
        Mock Remove-LocalUser -ModuleName StandardUser { }
        Mock Find-SULocalUser -ModuleName StandardUser { [pscustomobject]@{ Name = 'ci000000000000'; SID = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-1001') } }
        Remove-SUAccount -Name 'ci000000000000' -Sid 'S-1-5-21-1-2-3-1001'
        Should -Invoke Remove-LocalUser -ModuleName StandardUser -Times 1 -Exactly -ParameterFilter { "$SID" -eq 'S-1-5-21-1-2-3-1001' }
    }

    It 'Remove-SUAccount removes the account by its name when New-LocalUser never returned a SID' {
        Mock Remove-LocalUser -ModuleName StandardUser { }
        Mock Find-SULocalUser -ModuleName StandardUser { [pscustomobject]@{ Name = 'ci000000000000'; SID = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-1003') } }
        Remove-SUAccount -Name 'ci000000000000' -Sid ''
        Should -Invoke Remove-LocalUser -ModuleName StandardUser -Times 1 -Exactly -ParameterFilter { "$SID" -eq 'S-1-5-21-1-2-3-1003' }
    }

    It 'Remove-SUAccount never touches a name outside the run''s pattern' {
        { Remove-SUAccount -Name 'Administrator' -Sid '' } | Should -Throw -ErrorId 'ParameterArgumentValidationError*'
    }

    It 'Remove-SUScheduledTask leaves a missing task alone' {
        Mock Unregister-ScheduledTask -ModuleName StandardUser { throw 'must not run' }
        { Remove-SUScheduledTask -TaskName ('ci-standard-user-' + (New-StandardUserName)) } | Should -Not -Throw
        Should -Invoke Unregister-ScheduledTask -ModuleName StandardUser -Times 0 -Exactly
    }

    It 'Remove-SUScheduledTask passes on any other error' {
        Mock Get-ScheduledTask -ModuleName StandardUser { throw 'The RPC server is unavailable.' }
        Mock Unregister-ScheduledTask -ModuleName StandardUser { throw 'must not run' }
        { Remove-SUScheduledTask -TaskName 'ci-standard-user-ci000000000000' } | Should -Throw '*RPC server*'
    }

    It 'Remove-SUScheduledTask stops a running task before it unregisters it' {
        $script:TaskCalls = [System.Collections.Generic.List[string]]::new()
        Mock Get-ScheduledTask -ModuleName StandardUser { [pscustomobject]@{ State = 'Running' } }
        Mock Stop-ScheduledTask -ModuleName StandardUser { $script:TaskCalls.Add('stop') }
        Mock Unregister-ScheduledTask -ModuleName StandardUser { $script:TaskCalls.Add('unregister') }
        Remove-SUScheduledTask -TaskName 'ci-standard-user-ci000000000000'
        @($script:TaskCalls) | Should -Be @('stop', 'unregister')
    }

    It 'Remove-SUProfile leaves a missing profile alone' {
        Mock Remove-CimInstance -ModuleName StandardUser { throw 'must not run' }
        { Remove-SUProfile -Sid 'S-1-5-21-1-2-3-999999' } | Should -Not -Throw
        Should -Invoke Remove-CimInstance -ModuleName StandardUser -Times 0 -Exactly
    }

    It 'Remove-SUProfile rejects a value that is not a SID' {
        { Remove-SUProfile -Sid "x' OR SID LIKE '%" } | Should -Throw -ErrorId 'ParameterArgumentValidationError*'
    }

    It 'Remove-SUFolderAccess succeeds on a folder with no entry for the SID' {
        $dir = New-Item -ItemType Directory -Path (Join-Path $TestDrive 'acl') -Force
        { Remove-SUFolderAccess -Path $dir.FullName -Sid 'S-1-5-21-1-2-3-999999' } | Should -Not -Throw
    }

    It 'Remove-SUFolderAccess removes the entry of a SID that no longer resolves (a deleted account), and a retry is a no-op' {
        $dir = New-Item -ItemType Directory -Path (Join-Path $TestDrive 'acl-gone') -Force
        $id = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-999998')
        $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($dir, [System.Security.AccessControl.AccessControlSections]::Access)
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($id, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
        [System.IO.FileSystemAclExtensions]::SetAccessControl($dir, $acl)
        $count = { @([System.IO.FileSystemAclExtensions]::GetAccessControl($dir, [System.Security.AccessControl.AccessControlSections]::Access).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference -eq $id }).Count }
        & $count | Should -Be 1
        Remove-SUFolderAccess -Path $dir.FullName -Sid $id.Value
        & $count | Should -Be 0
        { Remove-SUFolderAccess -Path $dir.FullName -Sid $id.Value } | Should -Not -Throw
    }
}

Describe 'Grant-SUFolderAccess and Remove-SUFolderAccess: the account''s two folder entries' {
    BeforeAll {
        function Get-EntryFor([string] $Path, [System.Security.Principal.SecurityIdentifier] $Id) {
            $item = Get-Item -LiteralPath $Path -Force
            @([System.IO.FileSystemAclExtensions]::GetAccessControl($item, [System.Security.AccessControl.AccessControlSections]::Access).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
                    Where-Object { $_.IdentityReference -eq $Id })
        }
    }

    It 'grants <Rights> as one inheritable entry that reaches a new child file, and removes it from both' -TestCases @(
        @{ Rights = 'Modify'; Sid = 'S-1-5-21-1-2-3-999997' }
        @{ Rights = 'ReadAndExecute'; Sid = 'S-1-5-21-1-2-3-999996' }
    ) {
        $dir = (New-Item -ItemType Directory -Path (Join-Path $TestDrive "grant-$Rights") -Force).FullName
        $id = [System.Security.Principal.SecurityIdentifier]::new($Sid)
        $want = [System.Security.AccessControl.FileSystemRights] $Rights
        Grant-SUFolderAccess -Path $dir -Sid $Sid -Rights $Rights
        $entry = @(Get-EntryFor $dir $id)
        $entry.Count | Should -Be 1
        $entry[0].IsInherited | Should -BeFalse
        ($entry[0].FileSystemRights -band $want) | Should -Be $want
        $entry[0].InheritanceFlags | Should -Be ([System.Security.AccessControl.InheritanceFlags] 'ContainerInherit, ObjectInherit')
        $entry[0].AccessControlType | Should -Be 'Allow'
        if ($Rights -eq 'ReadAndExecute') {
            ($entry[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Write) | Should -Be 0
        }
        $file = Join-Path $dir 'child.txt'
        Set-Content -LiteralPath $file -Value 'x'
        @(Get-EntryFor $file $id | Where-Object { $_.IsInherited }).Count | Should -Be 1
        Remove-SUFolderAccess -Path $dir -Sid $Sid
        @(Get-EntryFor $dir $id).Count | Should -Be 0
        @(Get-EntryFor $file $id).Count | Should -Be 0
    }
}

Describe 'Secret handling' {
    It 'New-StandardUserPassword returns a SecureString of 32 characters with all four classes' {
        $secure = New-StandardUserPassword
        $secure | Should -BeOfType [securestring]
        $secure.Length | Should -Be 32
        $plain = [System.Net.NetworkCredential]::new('', $secure).Password
        $plain -cmatch '[A-Z]' | Should -BeTrue
        $plain -cmatch '[a-z]' | Should -BeTrue
        $plain -match '[0-9]' | Should -BeTrue
        $plain -match '[^A-Za-z0-9]' | Should -BeTrue
        $secure.IsReadOnly() | Should -BeTrue
    }

    It 'two passwords differ' {
        $a = [System.Net.NetworkCredential]::new('', (New-StandardUserPassword)).Password
        $b = [System.Net.NetworkCredential]::new('', (New-StandardUserPassword)).Password
        ($a -ceq $b) | Should -BeFalse
    }

    It 'with -EmitMask writes one line, ::add-mask:: and exactly the password, and nothing else' {
        # The line goes to a StringWriter, never to the console; the comparison prints no value.
        $writer = [System.IO.StringWriter]::new()
        $console = [Console]::Out
        [Console]::SetOut($writer)
        try { $secure = New-StandardUserPassword -EmitMask } finally { [Console]::SetOut($console) }
        $lines = @($writer.ToString() -split '\r?\n' | Where-Object { $_.Length })
        $lines.Count | Should -Be 1
        $lines[0].Length | Should -Be 44
        ($lines[0] -ceq ('::add-mask::' + [System.Net.NetworkCredential]::new('', $secure).Password)) | Should -BeTrue -Because 'the mask must hold the password itself'
    }

    It 'without -EmitMask writes nothing' {
        $writer = [System.IO.StringWriter]::new()
        $console = [Console]::Out
        [Console]::SetOut($writer)
        try { $null = New-StandardUserPassword } finally { [Console]::SetOut($console) }
        $writer.ToString() | Should -BeNullOrEmpty
    }

    It '<File> never builds a SecureString from plain text and never echoes a password' -TestCases @(@{ File = 'run-as-standard-user.ps1' }, @{ File = 'StandardUser.psm1' }) {
        $text = Get-Content -LiteralPath (Join-Path $script:ActionDir $File) -Raw
        $text | Should -Not -Match 'AsPlainText'
        $text | Should -Not -Match 'ConvertTo-SecureString'
        $text | Should -Not -Match 'Write-(Host|Output|RunnerLog)[^\r\n]*\$(password|plain|secure)\b'
    }

    It 'the child command line carries no password' {
        $line = Get-ChildCommandLine -Pwsh 'C:\pwsh\pwsh.exe' -Wrapper 'D:\a\_temp\o\wrapper.ps1'
        $line | Should -Be '"C:\pwsh\pwsh.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "D:\a\_temp\o\wrapper.ps1"'
    }
}

Describe 'New-StandardUserName' {
    It 'is ci and 12 hex digits, within New-LocalUser''s name limit and Remove-SUAccount''s pattern' {
        $name = New-StandardUserName
        $name | Should -MatchExactly '^ci[0-9a-f]{12}$'
        $limit = (Get-Command New-LocalUser).Parameters['Name'].Attributes | Where-Object { $_ -is [System.Management.Automation.ValidateLengthAttribute] }
        $name.Length | Should -BeLessOrEqual $limit.MaxLength
        $pattern = (Get-Command Remove-SUAccount).Parameters['Name'].Attributes | Where-Object { $_ -is [System.Management.Automation.ValidatePatternAttribute] }
        $name | Should -Match $pattern.RegexPattern
    }

    It 'two names differ' {
        New-StandardUserName | Should -Not -Be (New-StandardUserName)
    }
}

Describe 'New-WrapperText' {
    BeforeAll {
        $script:Wrapper = New-WrapperText -Out "D:\a\_temp\it's" -GroupsFile 'D:\a\_temp\g.csv' -UserFile 'D:\a\_temp\u.csv' -Log 'D:\a\_temp\o.log' -ScriptPath 'D:\a\r\probe.ps1' -Workspace 'D:\a\r'
    }

    It 'is valid PowerShell even with a quote in a path' {
        $errors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseInput($script:Wrapper, [ref] $null, [ref] $errors)
        @($errors).Count | Should -Be 0
        $script:Wrapper | Should -Match ([regex]::Escape("'D:\a\_temp\it''s'"))
    }

    It 'writes the user, then the groups, before it runs the script' {
        $user = $script:Wrapper.IndexOf('/user /fo csv')
        $groups = $script:Wrapper.IndexOf('/groups /fo csv')
        $user | Should -BeGreaterThan -1
        $groups | Should -BeGreaterThan $user
        $script:Wrapper.IndexOf('D:\a\r\probe.ps1') | Should -BeGreaterThan $groups
    }

    It 'sets STANDARD_USER_OUT and GITHUB_WORKSPACE for the child, by those exact names' {
        # Anchored on the whole assignment, so a misspelt name (GITHUB_WORKSPACE_X) fails.
        $script:Wrapper | Should -Match ('(?m)^' + [regex]::Escape('$env:STANDARD_USER_OUT = ''D:\a\_temp\it''''s''') + '\r?$')
        $script:Wrapper | Should -Match ('(?m)^' + [regex]::Escape('$env:GITHUB_WORKSPACE = ''D:\a\r''') + '\r?$')
    }
}

Describe 'The wrapper, run in a child pwsh as this user' {
    BeforeAll {
        $script:Script = Join-Path $TestDrive 'under-test.ps1'
        $script:Marker = Join-Path $TestDrive 'script-ran.txt'
        # The script records the two variables the wrapper sets for it.
        Set-Content -LiteralPath $script:Script -Value "Set-Content -LiteralPath '$($script:Marker)' -Value `"`$env:GITHUB_WORKSPACE|`$env:STANDARD_USER_OUT`"`n'hello from the script'`nexit 7"
        function Invoke-Wrapper([string] $Out) {
            $wrapper = Join-Path $TestDrive ('wrapper-' + [guid]::NewGuid().ToString('N') + '.ps1')
            New-WrapperText -Out $Out -GroupsFile (Join-Path $Out 'groups.csv') -UserFile (Join-Path $Out 'user.csv') -Log (Join-Path $Out 'output.log') -ScriptPath $script:Script -Workspace $TestDrive |
                Set-Content -LiteralPath $wrapper -Encoding utf8
            & $script:Pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $wrapper 2>$null | Out-Null
            $LASTEXITCODE
        }
    }

    BeforeEach {
        Remove-Item -LiteralPath $script:Marker -ErrorAction SilentlyContinue
    }

    It 'records the token, runs the script with its output in the log, and exits with its code' {
        $out = (New-Item -ItemType Directory -Path (Join-Path $TestDrive 'wrap-ok') -Force).FullName
        Invoke-Wrapper $out | Should -Be 7
        (Get-Content -LiteralPath $script:Marker -Raw).Trim() | Should -Be "$TestDrive|$out" -Because 'the script sees the workspace and the output folder the wrapper set'
        (ConvertFrom-WhoamiGroupsCsv -Text (Get-Content -LiteralPath (Join-Path $out 'groups.csv') -Raw)).Ok | Should -BeTrue
        (ConvertFrom-WhoamiUserCsv -Text (Get-Content -LiteralPath (Join-Path $out 'user.csv') -Raw)).Sid | Should -Be ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
        Get-Content -LiteralPath (Join-Path $out 'output.log') -Raw | Should -Match 'hello from the script'
    }

    It 'exits 93 without running the script when it cannot record the token, and leaves no groups file' {
        $out = Join-Path $TestDrive 'wrap-missing-folder'
        Invoke-Wrapper $out | Should -Be 93
        Test-Path -LiteralPath $script:Marker | Should -BeFalse
        Test-Path -LiteralPath (Join-Path $out 'groups.csv') | Should -BeFalse
    }
}

Describe 'The native helper' {
    It 'compiles and exposes the calls of both desktop routes and of the batch right' {
        Initialize-StandardUserNative
        $type = 'StandardUserNative' -as [type]
        $type | Should -Not -BeNullOrEmpty
        foreach ($method in 'SetStationAccess', 'AddAccountRight', 'RemoveAccountRights', 'StartWithLogonToken', 'WaitProcess', 'ProcessExitCode',
            'ReadStationSecurity', 'StationDesktopName', 'AccountRights') {
            $type.GetMethod($method) | Should -Not -BeNullOrEmpty -Because "$method is called by the module"
        }
    }

    It 'marshals LsaRemoveAccountRights'' AllRights as a one-byte BOOLEAN' {
        Initialize-StandardUserNative
        $method = ('StandardUserNative' -as [type]).GetMethod('LsaRemoveAccountRights', [System.Reflection.BindingFlags] 'NonPublic, Static')
        $marshal = $method.GetParameters()[2].GetCustomAttributes([System.Runtime.InteropServices.MarshalAsAttribute], $false)
        @($marshal).Count | Should -Be 1
        $marshal[0].Value | Should -Be ([System.Runtime.InteropServices.UnmanagedType]::U1)
    }
}

Describe 'action.yml and the run script' {
    BeforeAll {
        $script:Action = Get-Content -LiteralPath (Join-Path $script:ActionDir 'action.yml') -Raw
        $script:RunScript = Join-Path $script:ActionDir 'run-as-standard-user.ps1'
        $script:Module = Get-Content -LiteralPath (Join-Path $script:ActionDir 'StandardUser.psm1') -Raw
        $inputs = [regex]::Match($script:Action, '(?ms)^inputs:\r?\n(.*?)^outputs:').Groups[1].Value
        $script:Declared = @([regex]::Matches($inputs, '(?m)^  ([a-z][a-z-]*):') | ForEach-Object { $_.Groups[1].Value })
        $runs = [regex]::Match($script:Action, '(?ms)^runs:.*').Value
        $script:Used = @([regex]::Matches($runs, '\$\{\{\s*inputs\.([a-z][a-z-]*)\s*\}\}') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
    }

    It 'keeps every existing input: <Name>' -TestCases @(@{ Name = 'script' }, @{ Name = 'token' }, @{ Name = 'timeout-minutes' }) {
        $script:Action | Should -Match "(?m)^  ${Name}:"
    }

    It 'keeps the timeout default of 30 minutes' {
        $script:Action | Should -Match '(?ms)^  timeout-minutes:.*?default: "30"'
    }

    It 'adds desktop-route, optional, default auto' {
        $script:Action | Should -Match '(?ms)^  desktop-route:.*?default: auto'
        $script:Action | Should -Match '-DesktopRoute \$env:SU_DESKTOP_ROUTE'
    }

    It 'uses every input it declares, and declares every input it uses' {
        $script:Declared | Should -Be @('script', 'token', 'timeout-minutes', 'desktop-route')
        @($script:Used | Where-Object { $_ -notin $script:Declared }) | Should -BeNullOrEmpty
        @($script:Declared | Where-Object { $_ -notin $script:Used }) | Should -BeNullOrEmpty
    }

    It 'passes every SU_ variable it sets to the script, and sets every one it passes' {
        $set = @([regex]::Matches($script:Action, '(?m)^\s+(SU_[A-Z_]+):') | ForEach-Object { $_.Groups[1].Value })
        $passed = @([regex]::Matches($script:Action, '\$env:(SU_[A-Z_]+)') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
        $set.Count | Should -Be 4
        @($set | Where-Object { $_ -notin $passed }) | Should -BeNullOrEmpty
        @($passed | Where-Object { $_ -notin $set }) | Should -BeNullOrEmpty
    }

    It 'reads only step outputs the module writes' {
        $read = @([regex]::Matches($script:Action, 'steps\.run\.outputs\.([a-z][a-z-]*)') | ForEach-Object { $_.Groups[1].Value })
        $written = @([regex]::Matches($script:Module, 'Add-StepOutput -Name ([a-z][a-z-]*)') | ForEach-Object { $_.Groups[1].Value })
        $read | Should -Be @('route', 'out-dir')
        @($read | Where-Object { $_ -notin $written }) | Should -BeNullOrEmpty
    }

    It 'names the whole fallback (Windows Sandbox, a fresh restore point, the maintainer''s PC, only when the maintainer clicks Run)' {
        # A public template names a role, not a person.
        $script:Action | Should -Match 'Windows Sandbox'
        $script:Action | Should -Match 'restore point'
        $script:Action | Should -Match "maintainer's PC"
        $script:Action | Should -Match 'the maintainer clicks Run'
    }

    It 'the run script parses' {
        $errors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseFile($script:RunScript, [ref] $null, [ref] $errors)
        @($errors).Count | Should -Be 0
    }

    It 'the run script passes each of its parameters on as itself, to the parameter of the same name' {
        # From the syntax tree: every param() name of run-as-standard-user.ps1 reaches
        # Invoke-StandardUserRun's parameter of that name as the variable of that name, so
        # neither a constant (-Token desktop) nor a dropped -DesktopRoute goes unnoticed.
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:RunScript, [ref] $null, [ref] $null)
        $names = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
        $names | Should -Be @('Script', 'Token', 'TimeoutMinutes', 'DesktopRoute')
        $calls = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Invoke-StandardUserRun' }, $true))
        $calls.Count | Should -Be 1
        $binding = [System.Management.Automation.Language.StaticParameterBinder]::BindCommand($calls[0], $true)
        @($binding.BindingExceptions.Keys) | Should -BeNullOrEmpty
        foreach ($name in $names) {
            $binding.BoundParameters.ContainsKey($name) | Should -BeTrue -Because "-$name must be passed on"
            $value = $binding.BoundParameters[$name].Value
            $value | Should -BeOfType [System.Management.Automation.Language.VariableExpressionAst] -Because "-$name must get `$$name, not a constant or an expression ($value)"
            $value.VariablePath.UserPath | Should -Be $name
        }
    }

    It 'the run script hands the step to the module and keeps exit codes 90, 91 and 92' {
        $text = Get-Content -LiteralPath $script:RunScript -Raw
        $text | Should -Match 'Invoke-StandardUserRun'
        $text | Should -Match 'exit \$code'
        foreach ($code in 90, 91, 92) { $script:Module | Should -Match "Exit[A-Za-z]+ = $code\b" }
    }
}

Describe 'Every command call binds to the command''s parameters' {
    It 'every command call in <File> binds, with constant arguments its parameters accept' -TestCases @(
        @{ File = 'run-as-standard-user.ps1' }
        @{ File = 'StandardUser.psm1' }
        @{ File = 'probes/context-probe.ps1' }
        @{ File = 'probes/window-probe.ps1' }
        @{ File = 'probes/program-files-denied.ps1' }
        @{ File = 'probes/program-files-write.ps1' }
    ) {
        $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $script:ActionDir $File), [ref] $null, [ref] $null)
        Get-CommandCallProblem -Ast $ast -Label $File | Should -BeNullOrEmpty
    }

    It 'every command call in the generated wrapper binds' {
        $text = New-WrapperText -Out 'D:\o' -GroupsFile 'D:\o\g.csv' -UserFile 'D:\o\u.csv' -Log 'D:\o\o.log' -ScriptPath 'D:\r\p.ps1' -Workspace 'D:\r'
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref] $null, [ref] $null)
        Get-CommandCallProblem -Ast $ast -Label 'wrapper' | Should -BeNullOrEmpty
    }

    It 'the checker reports <Why>' -TestCases @(
        @{ Why = 'a description longer than New-LocalUser takes'; Code = "New-LocalUser -Name 'cizzzzzzzzzzzz' -NoPassword -Description 'CI standard user; deleted at the end of this step'"; Expect = '*-Description*49 characters*0 to 48*' }
        @{ Why = 'a value outside a ValidateSet'; Code = "Add-StandardUserItem -State `$s -Kind 'registry' -Data @{}"; Expect = "*-Kind 'registry'*not one of*" }
        @{ Why = 'a value its pattern refuses'; Code = "Remove-SUAccount -Name 'Administrator' -Sid ''"; Expect = "*-Name 'Administrator'*does not match*" }
        @{ Why = 'a value outside an enum'; Code = "Register-ScheduledTask -TaskName t -RunLevel 'Elevatedd' -ErrorAction Stop"; Expect = "*-RunLevel 'Elevatedd'*not a value*" }
        @{ Why = 'a parameter that does not exist'; Code = "Get-Item -LiteralPth 'x'"; Expect = '*-LiteralPth: NamedParameterNotFound*' }
        @{ Why = 'a command that does not exist'; Code = 'Invoke-StandardUserCleanp -State $s'; Expect = '*Invoke-StandardUserCleanp: the command is not found*' }
        @{ Why = 'a ScheduledTasks call without -ErrorAction'; Code = "Get-ScheduledTask -TaskName 't'"; Expect = '*a function of module ScheduledTasks called without -ErrorAction' }
    ) {
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($Code, [ref] $null, [ref] $null)
        $problems = @(Get-CommandCallProblem -Ast $ast -Label 'planted')
        $problems.Count | Should -Be 1
        $problems[0] | Should -BeLike $Expect
    }

    It 'the checker accepts dynamic provider parameters such as -Encoding and -Raw' {
        $ast = [System.Management.Automation.Language.Parser]::ParseInput("Get-Content -LiteralPath x -Raw -Encoding utf8; Set-Content -LiteralPath x -Value 1 -Encoding utf8", [ref] $null, [ref] $null)
        Get-CommandCallProblem -Ast $ast -Label 'dynamic' | Should -BeNullOrEmpty
    }
}

Describe 'Probes' {
    BeforeAll {
        $script:Probes = Join-Path $script:ActionDir 'probes'
        $script:UserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $script:Denied = (New-Item -ItemType Directory -Path (Join-Path $TestDrive 'denied') -Force).FullName
        $script:Open = (New-Item -ItemType Directory -Path (Join-Path $TestDrive 'open') -Force).FullName
        icacls $script:Denied /deny "*$($script:UserSid):(WD,AD)" | Out-Null
        function Invoke-Probe([string] $Name, [string[]] $Arguments = @(), [string] $Out = $TestDrive, [string] $Workspace = '') {
            $saved = $env:GITHUB_WORKSPACE
            $env:STANDARD_USER_OUT = $Out
            if ($Workspace) { $env:GITHUB_WORKSPACE = $Workspace }
            try { & $script:Pwsh -NoProfile -NonInteractive -File (Join-Path $script:Probes $Name) @Arguments | Out-Null; $LASTEXITCODE }
            finally {
                Remove-Item Env:\STANDARD_USER_OUT -ErrorAction SilentlyContinue
                if ($null -eq $saved) { Remove-Item Env:\GITHUB_WORKSPACE -ErrorAction SilentlyContinue } else { $env:GITHUB_WORKSPACE = $saved }
            }
        }
    }

    AfterAll {
        icacls $script:Denied /remove:d "*$($script:UserSid)" | Out-Null
    }

    It 'context-probe writes the groups, the integrity level, WSF_VISIBLE and the workspace result' {
        $out = (New-Item -ItemType Directory -Path (Join-Path $TestDrive 'ctx') -Force).FullName
        Invoke-Probe 'context-probe.ps1' -Out $out -Workspace $script:Open | Should -Be 0
        $context = Get-Content -LiteralPath (Join-Path $out 'context.json') -Raw | ConvertFrom-Json
        $context.integritySid | Should -Match '^S-1-16-\d+$'
        $context.wsfVisible | Should -BeOfType [bool]
        $context.windowStation | Should -Not -BeNullOrEmpty
        $context.workspaceWrite | Should -Be 'allowed'
        @(Get-ChildItem -LiteralPath $script:Open).Count | Should -Be 0
        $groups = Get-Content -LiteralPath (Join-Path $out 'probe-groups.csv') -Raw
        (ConvertFrom-WhoamiGroupsCsv -Text $groups).Ok | Should -BeTrue
    }

    It 'the action''s own records are the files <Name> that the module writes into the output folder' -TestCases @(
        @{ Name = 'wrapper.ps1' }, @{ Name = 'groups.csv' }, @{ Name = 'user.csv' }, @{ Name = 'output.log' }, @{ Name = 'result.json' }, @{ Name = 'cleanup.json' }
    ) {
        # The list the next two tests guard; it follows the module's own Join-Path calls.
        Get-Content -LiteralPath (Join-Path $script:ActionDir 'StandardUser.psm1') -Raw | Should -Match ([regex]::Escape("Join-Path `$out '$Name'"))
    }

    It '<File> writes none of the action''s own records into STANDARD_USER_OUT' -TestCases @(
        @{ File = 'context-probe.ps1'; Arguments = @() }
        @{ File = 'window-probe.ps1'; Arguments = @() }
        @{ File = 'program-files-denied.ps1'; Arguments = @('-Directory', '<denied>') }
        @{ File = 'program-files-write.ps1'; Arguments = @('-Directory', '<open>') }
    ) {
        # groups.csv and user.csv are the wrapper's record of the token, which the action's
        # check reads after the child ends; a probe that wrote them would be judged in its
        # place. Run, and read from the syntax tree, so a path the run does not reach counts too.
        $own = 'wrapper.ps1', 'groups.csv', 'user.csv', 'output.log', 'result.json', 'cleanup.json'
        $out = (New-Item -ItemType Directory -Path (Join-Path $TestDrive ('own-' + [guid]::NewGuid().ToString('N'))) -Force).FullName
        $resolved = @($Arguments | ForEach-Object { $_.Replace('<denied>', $script:Denied).Replace('<open>', $script:Open) })
        $null = Invoke-Probe $File -Arguments $resolved -Out $out -Workspace $script:Open
        @(Get-ChildItem -LiteralPath $out -File | Where-Object { $_.Name -in $own }).Name | Should -BeNullOrEmpty
        $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $script:Probes $File), [ref] $null, [ref] $null)
        $strings = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $n -is [System.Management.Automation.Language.ExpandableStringExpressionAst] }, $true) | ForEach-Object { $_.Value })
        $pattern = '(?:^|[\\/])(?:' + (($own | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')$'
        @($strings | Where-Object { $_ -match $pattern }) | Should -BeNullOrEmpty
    }

    It 'context-probe records a workspace it cannot write as denied' {
        $out = (New-Item -ItemType Directory -Path (Join-Path $TestDrive 'ctx-denied') -Force).FullName
        Invoke-Probe 'context-probe.ps1' -Out $out -Workspace $script:Denied | Should -Be 0
        (Get-Content -LiteralPath (Join-Path $out 'context.json') -Raw | ConvertFrom-Json).workspaceWrite | Should -Be 'denied'
    }

    It 'context-probe fails without STANDARD_USER_OUT' {
        & $script:Pwsh -NoProfile -NonInteractive -File (Join-Path $script:Probes 'context-probe.ps1') *> $null
        $LASTEXITCODE | Should -Be 2
    }

    It 'window-probe creates a window, proves its handle and closes it' {
        $out = (New-Item -ItemType Directory -Path (Join-Path $TestDrive 'win') -Force).FullName
        Invoke-Probe 'window-probe.ps1' -Out $out | Should -Be 0
        $window = Get-Content -LiteralPath (Join-Path $out 'window.json') -Raw | ConvertFrom-Json
        $window.handle | Should -BeGreaterThan 0
        $window.wasWindow | Should -BeTrue
        $window.destroyed | Should -BeTrue
    }

    It 'program-files-denied exits 0 when the write is denied' {
        Invoke-Probe 'program-files-denied.ps1' -Arguments @('-Directory', $script:Denied) | Should -Be 0
    }

    It 'program-files-denied exits 1 when the write succeeds, and leaves nothing behind' {
        Invoke-Probe 'program-files-denied.ps1' -Arguments @('-Directory', $script:Open) | Should -Be 1
        @(Get-ChildItem -LiteralPath $script:Open).Count | Should -Be 0
    }

    It 'program-files-write (the planted failure) exits 1 when the write is denied' {
        Invoke-Probe 'program-files-write.ps1' -Arguments @('-Directory', $script:Denied) | Should -Be 1
    }

    It 'program-files-write exits 0 when the write succeeds, and leaves nothing behind' {
        Invoke-Probe 'program-files-write.ps1' -Arguments @('-Directory', $script:Open) | Should -Be 0
        @(Get-ChildItem -LiteralPath $script:Open).Count | Should -Be 0
    }
}
