# SPDX-License-Identifier: MIT
# Pester 5 tests of Scripts/MountImage.ps1, with the disk image, volume and DISM commands mocked.
# The fake ISO is mounted as drive E: and holds the images each test names.

BeforeAll { . $PSScriptRoot/Harness.ps1 }

Describe 'MountImage.ps1' {
    BeforeEach {
        Mock Get-Volume { [pscustomobject]@{ DriveLetter = 'E' } }
        Mock Mount-DiskImage { [pscustomobject]@{ Attached = $true } }
        Mock Test-Path { $false }
        Mock Get-ItemProperty { [pscustomobject]@{ EditionID = 'Professional' } }
        # The first call lists the images of the file; each indexed call describes one of them.
        Mock Get-WindowsImage { @([pscustomobject]@{ ImageIndex = 1 }, [pscustomobject]@{ ImageIndex = 2 }, [pscustomobject]@{ ImageIndex = 3 }) }
        Mock Get-WindowsImage { [pscustomobject]@{ ImageIndex = 1; EditionId = 'Core' } } -ParameterFilter { $Index -eq 1 }
        Mock Get-WindowsImage { [pscustomobject]@{ ImageIndex = 2; EditionId = 'Professional' } } -ParameterFilter { $Index -eq 2 }
        Mock Get-WindowsImage { [pscustomobject]@{ ImageIndex = 3; EditionId = 'Professional' } } -ParameterFilter { $Index -eq 3 }
        Mock Get-DiskImage { [pscustomobject]@{ Attached = $false } }
    }

    Context 'when the ISO is not mounted yet' {
        It 'mounts it read-only and finds the first image of this PC''s edition' {
            Mock Test-Path { $true } -ParameterFilter { $LiteralPath -eq 'E:\sources\install.wim' }

            $messages = Invoke-EmbeddedScript MountImage @{ Path = 'C:\iso\windows.iso' }

            Should -Invoke Get-DiskImage -Times 1 -Exactly -ParameterFilter { $ImagePath -eq 'C:\iso\windows.iso' }
            Should -Invoke Mount-DiskImage -Times 1 -Exactly -ParameterFilter {
                $ImagePath -eq 'C:\iso\windows.iso' -and $StorageType -eq 'ISO' -and $Access -eq 'ReadOnly' -and $PassThru
            }
            $messages | Should -HaveCount 1
            $messages[0].state | Should -Be 'ready'
            $messages[0].source | Should -Be 'WIM:E:\sources\install.wim:2'
            $messages[0].mounted | Should -BeTrue
        }

        It 'uses install.esd as an ESD source when there is no install.wim' {
            Mock Test-Path { $true } -ParameterFilter { $LiteralPath -eq 'E:\sources\install.esd' }

            $messages = Invoke-EmbeddedScript MountImage @{ Path = 'C:\iso\windows.iso' }

            $messages[0].state | Should -Be 'ready'
            $messages[0].source | Should -Be 'ESD:E:\sources\install.esd:2'
        }

        It 'prefers install.wim when both exist' {
            Mock Test-Path { $true }

            $messages = Invoke-EmbeddedScript MountImage @{ Path = 'C:\iso\windows.iso' }

            $messages[0].source | Should -Be 'WIM:E:\sources\install.wim:2'
        }

        It 'reports that the ISO holds no Windows image' {
            $messages = Invoke-EmbeddedScript MountImage @{ Path = 'C:\iso\windows.iso' }

            $messages | Should -HaveCount 1
            $messages[0].state | Should -Be 'noimage'
            $messages[0].mounted | Should -BeTrue
            Should -Invoke Get-WindowsImage -Times 0 -Exactly
        }

        It 'reports the edition when no image of it is in the ISO' {
            Mock Test-Path { $true } -ParameterFilter { $LiteralPath -eq 'E:\sources\install.wim' }
            Mock Get-ItemProperty { [pscustomobject]@{ EditionID = 'Enterprise' } }

            $messages = Invoke-EmbeddedScript MountImage @{ Path = 'C:\iso\windows.iso' }

            $messages | Should -HaveCount 1
            $messages[0].state | Should -Be 'noedition'
            $messages[0].edition | Should -Be 'Enterprise'
            $messages[0].mounted | Should -BeTrue
        }
    }

    Context 'when the ISO is already mounted' {
        BeforeEach {
            Mock Get-DiskImage { [pscustomobject]@{ Attached = $true } }
            Mock Test-Path { $true } -ParameterFilter { $LiteralPath -eq 'E:\sources\install.wim' }
        }

        It 'does not mount it again and reports that it did not mount it' {
            $messages = Invoke-EmbeddedScript MountImage @{ Path = 'C:\iso\windows.iso' }

            Should -Invoke Mount-DiskImage -Times 0 -Exactly
            $messages | Should -HaveCount 1
            $messages[0].state | Should -Be 'ready'
            $messages[0].mounted | Should -BeFalse
        }
    }
}
