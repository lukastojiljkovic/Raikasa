# SPDX-License-Identifier: MIT
# PSScriptAnalyzer settings for the PowerShell scripts embedded in the app (Scripts/*.ps1).
# The scripts run in Windows PowerShell 5.1, so the syntax and the commands they call are
# checked against that version, on top of every default rule at Error and Warning severity.
@{
    Severity            = @('Error', 'Warning')
    IncludeDefaultRules = $true
    Rules               = @{
        PSUseCompatibleSyntax = @{
            Enable         = $true
            TargetVersions = @('5.1')
        }
    }
}
