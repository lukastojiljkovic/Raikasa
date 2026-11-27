# SPDX-License-Identifier: MIT
# Pester 5 tests of Scripts/SearchIndex.ps1, with the service and the registry mocked.

BeforeAll { . $PSScriptRoot/Harness.ps1 }

Describe 'SearchIndex.ps1' {
    BeforeEach {
        Mock Stop-Service {}
        Mock Start-Service {}
        Mock Set-ItemProperty {}
    }

    It 'skips when Windows Search is not installed' {
        Mock Get-Service { $null }

        $messages = Invoke-EmbeddedScript SearchIndex

        $messages | Should -HaveCount 1
        $messages[0].skipped | Should -Match 'turned off'
        Should -Invoke Stop-Service -Times 0 -Exactly
        Should -Invoke Set-ItemProperty -Times 0 -Exactly
    }

    It 'skips when Windows Search is disabled' {
        Mock Get-Service { [pscustomobject]@{ StartType = 'Disabled' } }

        $messages = Invoke-EmbeddedScript SearchIndex

        $messages | Should -HaveCount 1
        $messages[0].Keys | Should -Contain 'skipped'
        Should -Invoke Stop-Service -Times 0 -Exactly
        Should -Invoke Start-Service -Times 0 -Exactly
    }

    It 'stops the service, marks the index for a rebuild and starts the service again, in that order' {
        $order = [System.Collections.Generic.List[string]]::new()
        Mock Get-Service { [pscustomobject]@{ StartType = 'Automatic' } } -ParameterFilter { $Name -eq 'WSearch' }
        Mock Stop-Service { $order.Add('stop') }.GetNewClosure()
        Mock Set-ItemProperty { $order.Add('set') }.GetNewClosure()
        Mock Start-Service { $order.Add('start') }.GetNewClosure()

        $messages = Invoke-EmbeddedScript SearchIndex

        $order -join ',' | Should -Be 'stop,set,start'
        Should -Invoke Stop-Service -Times 1 -Exactly -ParameterFilter { $Name -eq 'WSearch' -and $Force }
        Should -Invoke Start-Service -Times 1 -Exactly -ParameterFilter { $Name -eq 'WSearch' }
        Should -Invoke Set-ItemProperty -Times 1 -Exactly -ParameterFilter {
            $Path -eq 'HKLM:\SOFTWARE\Microsoft\Windows Search' -and $Name -eq 'SetupCompletedSuccessfully' -and $Value -eq 0 -and $Type -eq 'DWord'
        }
        $messages | Should -HaveCount 1
        $messages[0].state | Should -Be 'rebuilding'
    }

    It 'rebuilds a service that starts on demand' {
        Mock Get-Service { [pscustomobject]@{ StartType = 'Manual' } }

        $messages = Invoke-EmbeddedScript SearchIndex

        $messages[0].state | Should -Be 'rebuilding'
    }
}
