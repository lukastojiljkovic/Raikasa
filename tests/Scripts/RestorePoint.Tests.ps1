# SPDX-License-Identifier: MIT
# Pester 5 tests of Scripts/RestorePoint.ps1, with the restore point commands mocked.

BeforeAll {
    . $PSScriptRoot/Harness.ps1

    # A restore point as Get-ComputerRestorePoint returns it: the creation time is a WMI (DMTF) string.
    function New-FakeRestorePoint([int] $Sequence, [datetime] $Created) {
        [pscustomobject]@{
            SequenceNumber = $Sequence
            CreationTime   = [Management.ManagementDateTimeConverter]::ToDmtfDateTime($Created)
        }
    }
}

Describe 'RestorePoint.ps1' {
    BeforeEach {
        Mock Checkpoint-Computer {}
    }

    It 'reports a restore point from the last 24 hours instead of making another' {
        $existing = New-FakeRestorePoint 7 (Get-Date).AddHours(-2)
        Mock Get-ComputerRestorePoint { $existing }.GetNewClosure()

        $messages = Invoke-EmbeddedScript RestorePoint @{ Description = 'Test point' }

        $messages | Should -HaveCount 1
        $messages[0].state | Should -Be 'recent'
        [datetime]::Parse($messages[0].created) | Should -BeGreaterThan (Get-Date).AddHours(-3)
        Should -Invoke Checkpoint-Computer -Times 0 -Exactly
    }

    It 'compares the newest restore point, not the first one listed' {
        $listed = @(
            New-FakeRestorePoint 2 (Get-Date).AddHours(-1)
            New-FakeRestorePoint 9 (Get-Date).AddDays(-5)
        )
        $calls = [System.Collections.Generic.Queue[object]]::new()
        $calls.Enqueue($listed)
        $calls.Enqueue(@($listed + (New-FakeRestorePoint 10 (Get-Date))))
        Mock Get-ComputerRestorePoint { $calls.Dequeue() }.GetNewClosure()

        $messages = Invoke-EmbeddedScript RestorePoint @{ Description = 'Test point' }

        Should -Invoke Checkpoint-Computer -Times 1 -Exactly
        $messages[0].state | Should -Be 'created'
    }

    It 'creates a restore point with the given description when the last one is older than 24 hours' {
        $calls = [System.Collections.Generic.Queue[object]]::new()
        $calls.Enqueue((New-FakeRestorePoint 3 (Get-Date).AddHours(-30)))
        $calls.Enqueue((New-FakeRestorePoint 4 (Get-Date)))
        Mock Get-ComputerRestorePoint { $calls.Dequeue() }.GetNewClosure()

        $messages = Invoke-EmbeddedScript RestorePoint @{ Description = 'Test point' }

        Should -Invoke Checkpoint-Computer -Times 1 -Exactly -ParameterFilter {
            $Description -eq 'Test point' -and $RestorePointType -eq 'MODIFY_SETTINGS'
        }
        $messages | Should -HaveCount 1
        $messages[0].state | Should -Be 'created'
    }

    It 'creates the first restore point when none can be listed' {
        $first = New-FakeRestorePoint 1 (Get-Date)
        $calls = [System.Collections.Generic.Queue[scriptblock]]::new()
        $calls.Enqueue({ throw 'System Restore is turned off.' })
        $calls.Enqueue({ $first }.GetNewClosure())
        Mock Get-ComputerRestorePoint { & $calls.Dequeue() }.GetNewClosure()

        $messages = Invoke-EmbeddedScript RestorePoint @{ Description = 'Test point' }

        Should -Invoke Checkpoint-Computer -Times 1 -Exactly
        $messages[0].state | Should -Be 'created'
    }

    It 'reports that none was created when Windows silently refuses (the sequence number did not move)' {
        $same = New-FakeRestorePoint 3 (Get-Date).AddHours(-30)
        Mock Get-ComputerRestorePoint { $same }.GetNewClosure()

        $messages = Invoke-EmbeddedScript RestorePoint @{ Description = 'Test point' }

        Should -Invoke Checkpoint-Computer -Times 1 -Exactly
        $messages | Should -HaveCount 1
        $messages[0].state | Should -Be 'notcreated'
    }

    It 'reports that none was created when there was none before and there is none after' {
        Mock Get-ComputerRestorePoint { throw 'System Restore is turned off.' }

        $messages = Invoke-EmbeddedScript RestorePoint @{ Description = 'Test point' }

        $messages[0].state | Should -Be 'notcreated'
    }
}
