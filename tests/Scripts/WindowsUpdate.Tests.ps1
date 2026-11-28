# SPDX-License-Identifier: MIT
# Pester 5 tests of Scripts/WindowsUpdate.ps1. The Windows Update Agent COM objects are fakes
# (plain objects with script methods) handed out by a mocked New-Object, so nothing here
# searches for, downloads or installs an update. Each fake writes what it was asked to do to
# a log, which the tests read back.

BeforeAll {
    . $PSScriptRoot/Harness.ps1

    # What the Windows Update Agent returns from Download() and Install().
    function New-FakeResult([int] $ResultCode, [int] $Overall = 0, [int] $ForUpdate = 0, [bool] $RebootRequired = $false) {
        $result = [pscustomobject]@{ ResultCode = $ResultCode; HResult = $Overall; RebootRequired = $RebootRequired }
        $update = [pscustomobject]@{ HResult = $ForUpdate }
        $result | Add-Member -MemberType ScriptMethod -Name GetUpdateResult -Value { param($index) $update }.GetNewClosure()
        $result
    }

    function New-FakeUpdate([string] $Title, [bool] $Downloaded = $true, [bool] $EulaAccepted = $true, [bool] $CanRequestUserInput = $false, $Log) {
        $update = [pscustomobject]@{
            Title                = $Title
            IsDownloaded         = $Downloaded
            EulaAccepted         = $EulaAccepted
            InstallationBehavior = [pscustomobject]@{ CanRequestUserInput = $CanRequestUserInput }
        }
        $update | Add-Member -MemberType ScriptMethod -Name AcceptEula -Value { $Log.Add("eula:$Title") }.GetNewClosure()
        $update
    }

    # A session whose one searcher, downloader and installer find $Updates and return the result
    # kept for the update's title (success when none is given), and whose installer can create
    # a stop file, as a user stopping the run would. Each closure is made here, in the function's
    # own scope, where every variable it uses is a local.
    function New-FakeSession($Updates, [hashtable] $DownloadResults = @{}, [hashtable] $InstallResults = @{}, [string] $StopFileOnInstall, $Log) {
        $success = New-FakeResult 2

        $searcher = [pscustomobject]@{}
        $searcher | Add-Member -MemberType ScriptMethod -Name Search -Value {
            param($criteria)
            $Log.Add("search:$criteria")
            [pscustomobject]@{ Updates = $Updates }
        }.GetNewClosure()

        $downloader = [pscustomobject]@{ Updates = $null }
        $downloader | Add-Member -MemberType ScriptMethod -Name Download -Value {
            $title = $this.Updates.Items[0].Title
            $Log.Add("download:$title")
            if ($DownloadResults.ContainsKey($title)) { $DownloadResults[$title] } else { $success }
        }.GetNewClosure()

        $installer = [pscustomobject]@{ Updates = $null; ForceQuiet = $false }
        $installer | Add-Member -MemberType ScriptMethod -Name Install -Value {
            $title = $this.Updates.Items[0].Title
            $Log.Add("install:$title quiet=$($this.ForceQuiet)")
            if ($StopFileOnInstall) { Set-Content -LiteralPath $StopFileOnInstall -Value 'stop' }
            if ($InstallResults.ContainsKey($title)) { $InstallResults[$title] } else { $success }
        }.GetNewClosure()

        $session = [pscustomobject]@{ ClientApplicationID = $null }
        $session | Add-Member -MemberType ScriptMethod -Name CreateUpdateSearcher -Value { $searcher }.GetNewClosure()
        $session | Add-Member -MemberType ScriptMethod -Name CreateUpdateDownloader -Value { $downloader }.GetNewClosure()
        $session | Add-Member -MemberType ScriptMethod -Name CreateUpdateInstaller -Value { $installer }.GetNewClosure()
        $session
    }

    # A fresh UpdateColl: the Add the script calls keeps the update where the fakes can read it.
    $script:NewCollection = {
        $collection = [pscustomobject]@{ Items = [System.Collections.Generic.List[object]]::new() }
        $collection | Add-Member -MemberType ScriptMethod -Name Add -Value { param($item) $this.Items.Add($item); $this.Items.Count - 1 }
        $collection
    }
}

Describe 'WindowsUpdate.ps1' {
    BeforeEach {
        $log = [System.Collections.Generic.List[string]]::new()
        $stopFile = Join-Path $TestDrive 'stop.txt'
        $newCollection = $script:NewCollection
        Mock New-Object { throw "Unexpected COM object $ComObject." }
        Mock New-Object { & $newCollection }.GetNewClosure() -ParameterFilter { $ComObject -eq 'Microsoft.Update.UpdateColl' }
    }

    It 'finds no updates and finishes without a restart' {
        $session = New-FakeSession -Updates @() -Log $log
        Mock New-Object { $session }.GetNewClosure() -ParameterFilter { $ComObject -eq 'Microsoft.Update.Session' }

        $messages = Invoke-EmbeddedScript WindowsUpdate @{ StopFile = $stopFile; ClientId = 'TestClient' }

        $messages | Should -HaveCount 3
        $messages[0].phase | Should -Be 'searching'
        $messages[1].found | Should -Be 0
        $messages[2].done | Should -BeTrue
        $messages[2].restart | Should -BeFalse
        $session.ClientApplicationID | Should -Be 'TestClient'
        $log | Should -Contain 'search:IsInstalled=0 and IsHidden=0 and BrowseOnly=0'
    }

    It 'leaves out an update that needs user input' {
        $updates = @(
            New-FakeUpdate 'Needs input' -CanRequestUserInput $true -Log $log
            New-FakeUpdate 'Plain' -Log $log
        )
        $session = New-FakeSession -Updates $updates -Log $log
        Mock New-Object { $session }.GetNewClosure() -ParameterFilter { $ComObject -eq 'Microsoft.Update.Session' }

        $messages = Invoke-EmbeddedScript WindowsUpdate @{ StopFile = $stopFile; ClientId = 'TestClient' }

        ($messages | Where-Object { $_.ContainsKey('found') }).found | Should -Be 1
        $log | Should -Contain 'install:Plain quiet=True'
        $log | Should -Not -Contain 'install:Needs input quiet=True'
    }

    It 'installs an update that is already downloaded, without downloading it again' {
        $updates = @(New-FakeUpdate 'Cumulative' -Log $log)
        $session = New-FakeSession -Updates $updates -Log $log
        Mock New-Object { $session }.GetNewClosure() -ParameterFilter { $ComObject -eq 'Microsoft.Update.Session' }

        $messages = Invoke-EmbeddedScript WindowsUpdate @{ StopFile = $stopFile; ClientId = 'TestClient' }

        $log | Where-Object { $_ -like 'download:*' } | Should -BeNullOrEmpty
        ($messages | Where-Object { $_.ContainsKey('installed') }).installed | Should -Be 'Cumulative'
        $installing = $messages | Where-Object { $_.phase -eq 'installing' }
        $installing.update | Should -Be 'Cumulative'
        $installing.index | Should -Be 1
        $installing.count | Should -Be 1
    }

    It 'downloads first and accepts the licence terms when they were not accepted' {
        $updates = @(New-FakeUpdate 'Driver' -Downloaded $false -EulaAccepted $false -Log $log)
        $session = New-FakeSession -Updates $updates -Log $log
        Mock New-Object { $session }.GetNewClosure() -ParameterFilter { $ComObject -eq 'Microsoft.Update.Session' }

        $messages = Invoke-EmbeddedScript WindowsUpdate @{ StopFile = $stopFile; ClientId = 'TestClient' }

        ($log -join '|') | Should -Be 'search:IsInstalled=0 and IsHidden=0 and BrowseOnly=0|eula:Driver|download:Driver|install:Driver quiet=True'
        ($messages | Where-Object { $_.phase -eq 'downloading' }).update | Should -Be 'Driver'
    }

    It 'goes on to the next update when a download fails, and reports the update''s own error' {
        $updates = @(
            New-FakeUpdate 'Broken' -Downloaded $false -Log $log
            New-FakeUpdate 'Fine' -Log $log
        )
        $downloads = @{ 'Broken' = (New-FakeResult 4 -Overall 111 -ForUpdate -2145124300) }
        $session = New-FakeSession -Updates $updates -DownloadResults $downloads -Log $log
        Mock New-Object { $session }.GetNewClosure() -ParameterFilter { $ComObject -eq 'Microsoft.Update.Session' }

        $messages = Invoke-EmbeddedScript WindowsUpdate @{ StopFile = $stopFile; ClientId = 'TestClient' }

        $failed = @($messages | Where-Object { $_.ContainsKey('failed') })
        $failed | Should -HaveCount 1
        $failed[0].failed | Should -Be 'Broken'
        $failed[0].hresult | Should -Be -2145124300
        $log | Should -Not -Contain 'install:Broken quiet=True'
        $log | Should -Contain 'install:Fine quiet=True'
    }

    It 'continues after a download that finished with errors' {
        $updates = @(New-FakeUpdate 'Partly' -Downloaded $false -Log $log)
        $downloads = @{ 'Partly' = (New-FakeResult 3) }
        $session = New-FakeSession -Updates $updates -DownloadResults $downloads -Log $log
        Mock New-Object { $session }.GetNewClosure() -ParameterFilter { $ComObject -eq 'Microsoft.Update.Session' }

        Invoke-EmbeddedScript WindowsUpdate @{ StopFile = $stopFile; ClientId = 'TestClient' } | Out-Null

        $log | Should -Contain 'install:Partly quiet=True'
    }

    It 'reports a failed install with the operation''s error when the update has none' {
        $updates = @(New-FakeUpdate 'Stubborn' -Log $log)
        $installs = @{ 'Stubborn' = (New-FakeResult 4 -Overall -2147024891 -ForUpdate 0) }
        $session = New-FakeSession -Updates $updates -InstallResults $installs -Log $log
        Mock New-Object { $session }.GetNewClosure() -ParameterFilter { $ComObject -eq 'Microsoft.Update.Session' }

        $messages = Invoke-EmbeddedScript WindowsUpdate @{ StopFile = $stopFile; ClientId = 'TestClient' }

        $failed = @($messages | Where-Object { $_.ContainsKey('failed') })
        $failed[0].failed | Should -Be 'Stubborn'
        $failed[0].hresult | Should -Be -2147024891
        $messages | Where-Object { $_.ContainsKey('installed') } | Should -BeNullOrEmpty
        ($messages | Where-Object { $_.ContainsKey('done') }).restart | Should -BeFalse
    }

    It 'asks for a restart when an install needs one, even if a later one does not' {
        $updates = @(
            New-FakeUpdate 'Needs restart' -Log $log
            New-FakeUpdate 'Does not' -Log $log
        )
        $installs = @{ 'Needs restart' = (New-FakeResult 2 -RebootRequired $true); 'Does not' = (New-FakeResult 3) }
        $session = New-FakeSession -Updates $updates -InstallResults $installs -Log $log
        Mock New-Object { $session }.GetNewClosure() -ParameterFilter { $ComObject -eq 'Microsoft.Update.Session' }

        $messages = Invoke-EmbeddedScript WindowsUpdate @{ StopFile = $stopFile; ClientId = 'TestClient' }

        @($messages | Where-Object { $_.ContainsKey('installed') } | ForEach-Object { $_.installed }) | Should -Be @('Needs restart', 'Does not')
        ($messages | Where-Object { $_.ContainsKey('done') }).restart | Should -BeTrue
    }

    It 'stops between updates when the stop file appears, never halfway through one' {
        $updates = @(
            New-FakeUpdate 'First' -Log $log
            New-FakeUpdate 'Second' -Log $log
        )
        $session = New-FakeSession -Updates $updates -StopFileOnInstall $stopFile -Log $log
        Mock New-Object { $session }.GetNewClosure() -ParameterFilter { $ComObject -eq 'Microsoft.Update.Session' }

        $messages = Invoke-EmbeddedScript WindowsUpdate @{ StopFile = $stopFile; ClientId = 'TestClient' }

        $log | Should -Contain 'install:First quiet=True'
        $log | Should -Not -Contain 'install:Second quiet=True'
        ($messages | Where-Object { $_.ContainsKey('stopped') }).stopped | Should -BeTrue
        ($messages | Where-Object { $_.ContainsKey('installed') }).installed | Should -Be 'First'
        $messages[-1].done | Should -BeTrue
    }

    It 'does not start when the stop file is already there' {
        Set-Content -LiteralPath $stopFile -Value 'stop'
        $updates = @(New-FakeUpdate 'First' -Log $log)
        $session = New-FakeSession -Updates $updates -Log $log
        Mock New-Object { $session }.GetNewClosure() -ParameterFilter { $ComObject -eq 'Microsoft.Update.Session' }

        $messages = Invoke-EmbeddedScript WindowsUpdate @{ StopFile = $stopFile; ClientId = 'TestClient' }

        $log | Where-Object { $_ -like 'install:*' } | Should -BeNullOrEmpty
        ($messages | Where-Object { $_.ContainsKey('stopped') }).stopped | Should -BeTrue
    }
}
