# SPDX-License-Identifier: MIT
# Pester 5 tests of Scripts/DeliveryOptimization.ps1.

BeforeAll { . $PSScriptRoot/Harness.ps1 }

Describe 'DeliveryOptimization.ps1' {
    BeforeEach {
        Mock Delete-DeliveryOptimizationCache {}
    }

    It 'empties the cache and reports the free space it returned to the system drive' {
        $sizes = [System.Collections.Generic.Queue[long]]::new([long[]]@(1000, 1350))
        Mock Get-Volume { [pscustomobject]@{ SizeRemaining = $sizes.Dequeue() } }.GetNewClosure()

        $messages = Invoke-EmbeddedScript DeliveryOptimization

        $messages | Should -HaveCount 1
        $messages[0].freed | Should -Be 350
        Should -Invoke Delete-DeliveryOptimizationCache -Times 1 -Exactly -ParameterFilter { $Force }
        Should -Invoke Get-Volume -Times 2 -Exactly -ParameterFilter { $DriveLetter -eq $env:SystemDrive.TrimEnd(':') }
    }

    It 'reports nothing freed when the drive has less free space afterwards' {
        $sizes = [System.Collections.Generic.Queue[long]]::new([long[]]@(1000, 900))
        Mock Get-Volume { [pscustomobject]@{ SizeRemaining = $sizes.Dequeue() } }.GetNewClosure()

        $messages = Invoke-EmbeddedScript DeliveryOptimization

        $messages | Should -HaveCount 1
        $messages[0].freed | Should -Be 0
    }

    It 'measures the free space before it empties the cache, not after' {
        $order = [System.Collections.Generic.List[string]]::new()
        Mock Get-Volume { $order.Add('volume'); [pscustomobject]@{ SizeRemaining = 1 } }.GetNewClosure()
        Mock Delete-DeliveryOptimizationCache { $order.Add('delete') }.GetNewClosure()

        Invoke-EmbeddedScript DeliveryOptimization | Out-Null

        $order -join ',' | Should -Be 'volume,delete,volume'
    }
}
