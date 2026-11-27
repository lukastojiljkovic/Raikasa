# SPDX-License-Identifier: MIT
# Pester 5 tests of Scripts/Defender.ps1, with every Defender command mocked. A mock body
# sees test data only through .GetNewClosure(), so each test builds its own mock.

BeforeAll { . $PSScriptRoot/Harness.ps1 }

Describe 'Defender.ps1' {
    BeforeEach {
        Mock Update-MpSignature {}
        Mock Start-MpScan {}
        Mock Get-MpThreatDetection { @() }
        Mock Get-MpThreat {}
    }

    Context 'when Defender is not the active antivirus' {
        It 'skips when the status cannot be read' {
            Mock Get-MpComputerStatus { throw 'The Defender service is not running.' }

            $messages = Invoke-EmbeddedScript Defender @{ Action = 'update' }

            $messages | Should -HaveCount 1
            $messages[0].skipped | Should -Match 'isn''t the active antivirus'
            Should -Invoke Update-MpSignature -Times 0 -Exactly
            Should -Invoke Start-MpScan -Times 0 -Exactly
        }

        It 'skips when the antivirus is switched off' {
            $status = [pscustomobject]@{ AntivirusEnabled = $false; AMRunningMode = 'Normal' }
            Mock Get-MpComputerStatus { $status }.GetNewClosure()

            $messages = Invoke-EmbeddedScript Defender @{ Action = 'scan' }

            $messages | Should -HaveCount 1
            $messages[0].Keys | Should -Contain 'skipped'
            Should -Invoke Start-MpScan -Times 0 -Exactly
        }

        It 'skips when another product has put it in <Mode> mode' -ForEach @(
            @{ Mode = 'Passive' }
            @{ Mode = 'EDR Block Mode' }
        ) {
            $status = [pscustomobject]@{ AntivirusEnabled = $true; AMRunningMode = $Mode }
            Mock Get-MpComputerStatus { $status }.GetNewClosure()

            $messages = Invoke-EmbeddedScript Defender @{ Action = 'update' }

            $messages | Should -HaveCount 1
            $messages[0].Keys | Should -Contain 'skipped'
            Should -Invoke Update-MpSignature -Times 0 -Exactly
        }
    }

    Context 'when Defender is active' {
        It 'treats a missing running mode as active' {
            $status = [pscustomobject]@{ AntivirusEnabled = $true; AMRunningMode = $null; AntivirusSignatureVersion = '9.9' }
            Mock Get-MpComputerStatus { $status }.GetNewClosure()

            $messages = Invoke-EmbeddedScript Defender @{ Action = 'update' }

            $messages | Should -HaveCount 1
            $messages[0].version | Should -Be '9.9'
        }

        It 'updates the definitions and reports the new version' {
            $status = [pscustomobject]@{ AntivirusEnabled = $true; AMRunningMode = 'Normal'; AntivirusSignatureVersion = '1.2.3.4' }
            Mock Get-MpComputerStatus { $status }.GetNewClosure()

            $messages = Invoke-EmbeddedScript Defender @{ Action = 'update' }

            Should -Invoke Update-MpSignature -Times 1 -Exactly
            Should -Invoke Start-MpScan -Times 0 -Exactly
            $messages | Should -HaveCount 1
            $messages[0].version | Should -Be '1.2.3.4'
        }

        It 'runs a quick scan and reports no threats when none were found' {
            $status = [pscustomobject]@{ AntivirusEnabled = $true; AMRunningMode = 'Normal' }
            Mock Get-MpComputerStatus { $status }.GetNewClosure()

            $messages = Invoke-EmbeddedScript Defender @{ Action = 'scan' }

            Should -Invoke Start-MpScan -Times 1 -Exactly -ParameterFilter { $ScanType -eq 'QuickScan' }
            Should -Invoke Update-MpSignature -Times 0 -Exactly
            $messages | Should -HaveCount 1
            $messages[0].threats | Should -Be 0
            @($messages[0].names) | Should -HaveCount 0
        }

        It 'counts only the detections made during the scan and names each threat once' {
            $status = [pscustomobject]@{ AntivirusEnabled = $true; AMRunningMode = 'Normal' }
            Mock Get-MpComputerStatus { $status }.GetNewClosure()
            $detections = @(
                [pscustomobject]@{ ThreatID = 1; InitialDetectionTime = (Get-Date).AddDays(-3) }
                [pscustomobject]@{ ThreatID = 2; InitialDetectionTime = (Get-Date).AddMinutes(5) }
                [pscustomobject]@{ ThreatID = 3; InitialDetectionTime = (Get-Date).AddMinutes(6) }
                [pscustomobject]@{ ThreatID = 4; InitialDetectionTime = (Get-Date).AddMinutes(7) }
            )
            Mock Get-MpThreatDetection { $detections }.GetNewClosure()
            Mock Get-MpThreat { [pscustomobject]@{ ThreatName = 'Old.Test' } } -ParameterFilter { $ThreatID -eq 1 }
            Mock Get-MpThreat { [pscustomobject]@{ ThreatName = 'Zeta.Test' } } -ParameterFilter { $ThreatID -in 2, 4 }
            Mock Get-MpThreat { [pscustomobject]@{ ThreatName = 'Alpha.Test' } } -ParameterFilter { $ThreatID -eq 3 }

            $messages = Invoke-EmbeddedScript Defender @{ Action = 'scan' }

            $messages | Should -HaveCount 1
            $messages[0].threats | Should -Be 3
            @($messages[0].names) | Should -Be @('Alpha.Test', 'Zeta.Test')
        }
    }
}
