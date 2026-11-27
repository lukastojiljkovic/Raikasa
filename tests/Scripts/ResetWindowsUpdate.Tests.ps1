# SPDX-License-Identifier: MIT
# Pester 5 tests of Scripts/ResetWindowsUpdate.ps1. Services and the file system are mocked,
# so nothing here stops a service or renames a folder.

BeforeAll { . $PSScriptRoot/Harness.ps1 }

Describe 'ResetWindowsUpdate.ps1' {
    BeforeEach {
        Mock Stop-Service {}
        Mock Start-Service {}
        Mock Remove-Item {}
        Mock Rename-Item {}
    }

    It 'stops the three services, sets both cache folders aside and starts the services again' {
        Mock Test-Path { $true } -ParameterFilter { $LiteralPath -notlike '*.bak' }
        Mock Test-Path { $false } -ParameterFilter { $LiteralPath -like '*.bak' }

        $messages = Invoke-EmbeddedScript ResetWindowsUpdate

        Should -Invoke Stop-Service -Times 1 -Exactly -ParameterFilter { ($Name -join ',') -eq 'wuauserv,bits,cryptsvc' -and $Force }
        Should -Invoke Rename-Item -Times 1 -Exactly -ParameterFilter { $LiteralPath -like '*\SoftwareDistribution' -and $NewName -eq 'SoftwareDistribution.bak' }
        Should -Invoke Rename-Item -Times 1 -Exactly -ParameterFilter { $LiteralPath -like '*\System32\catroot2' -and $NewName -eq 'catroot2.bak' }
        Should -Invoke Remove-Item -Times 0 -Exactly
        Should -Invoke Start-Service -Times 1 -Exactly -ParameterFilter { ($Name -join ',') -eq 'wuauserv,bits,cryptsvc' }
        $messages | Should -HaveCount 1
        $messages[0].state | Should -Be 'reset'
    }

    It 'replaces an older backup before it renames the folder' {
        $order = [System.Collections.Generic.List[string]]::new()
        Mock Test-Path { $true }
        Mock Remove-Item { $order.Add('remove') }.GetNewClosure()
        Mock Rename-Item { $order.Add('rename') }.GetNewClosure()

        Invoke-EmbeddedScript ResetWindowsUpdate | Out-Null

        $order -join ',' | Should -Be 'remove,rename,remove,rename'
        Should -Invoke Remove-Item -Times 1 -Exactly -ParameterFilter { $LiteralPath -like '*\SoftwareDistribution.bak' -and $Recurse -and $Force }
        Should -Invoke Remove-Item -Times 1 -Exactly -ParameterFilter { $LiteralPath -like '*\catroot2.bak' -and $Recurse -and $Force }
    }

    It 'leaves a folder that does not exist alone' {
        Mock Test-Path { $false }

        $messages = Invoke-EmbeddedScript ResetWindowsUpdate

        Should -Invoke Rename-Item -Times 0 -Exactly
        Should -Invoke Remove-Item -Times 0 -Exactly
        $messages[0].state | Should -Be 'reset'
    }

    It 'starts the services again when a step fails' {
        Mock Test-Path { $true }
        Mock Rename-Item { throw 'The folder is in use.' }

        { Invoke-EmbeddedScript ResetWindowsUpdate } | Should -Throw '*in use*'

        Should -Invoke Start-Service -Times 1 -Exactly
    }

    It 'starts the services again when they cannot be stopped' {
        Mock Test-Path { $true }
        Mock Stop-Service { throw 'Access is denied.' }

        { Invoke-EmbeddedScript ResetWindowsUpdate } | Should -Throw '*denied*'

        Should -Invoke Start-Service -Times 1 -Exactly
        Should -Invoke Rename-Item -Times 0 -Exactly
    }
}
