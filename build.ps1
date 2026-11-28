#Requires -Version 5.1
<#
.SYNOPSIS
    Tests Raikasa, publishes a self-contained x64 build with its third-party licenses and compiles the Inno Setup
    installer.
.OUTPUTS
    artifacts\installer\Raikasa-<version>-Setup.exe
#>
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Invoke-Step([string] $name, [scriptblock] $command) {
    Write-Host "==> $name" -ForegroundColor Cyan
    & $command
    if ($LASTEXITCODE) { throw "$name failed with exit code $LASTEXITCODE." }
}

# The installer is compiled with Inno Setup 7.1.1 from the vendor's own download (jrsoftware.org; CI pins its URL and
# SHA-256, and sets ISCC to the ISCC.exe it installed). Set ISCC to its ISCC.exe, or install it per user at the
# default place. Only that version builds the installer.
$innoVersion = '7.1.1'
$iscc = if ($env:ISCC) { $env:ISCC } else { "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe" }
if (-not (Test-Path -LiteralPath $iscc)) { throw "Inno Setup $innoVersion was not found at $iscc. Install it from https://jrsoftware.org/isdl.php or set ISCC to its ISCC.exe." }
# The compiler names its engine version when it compiles a script, so a tiny one is compiled with the output off.
$engine = @('[Setup]', 'AppName=version-check', 'AppVersion=1', 'DefaultDirName=version-check') | & $iscc --output=no - | Out-String
if ($engine -notmatch 'Compiler engine version: Inno Setup (\S+)') { throw "$iscc did not report an Inno Setup version." }
if ($Matches[1] -ne $innoVersion) { throw "Inno Setup $($Matches[1]) was found at $iscc, but the installer is built with $innoVersion. Install $innoVersion or set ISCC to its ISCC.exe." }

# The product name and the version come from Directory.Build.props, the one place that spells them.
$props = ([xml](Get-Content "$root\Directory.Build.props")).Project.PropertyGroup
$version = $props.Version
$productName = $props.ProductName
$publishDir = "$root\artifacts\publish\win-x64"

# global.json, which selects the Microsoft.Testing.Platform test runner, is found from the working directory.
Invoke-Step 'Test' { Push-Location $root; try { dotnet test --project "tests\$productName.Core.Tests" -c Release } finally { Pop-Location } }

if (Test-Path $publishDir) { Remove-Item $publishDir -Recurse -Force }
Invoke-Step 'Publish' { dotnet publish "$root\src\$productName\$productName.csproj" -c Release -r win-x64 -p:Platform=x64 -p:PublishReadyToRun=true -o $publishDir --nologo }

# The self-contained build redistributes the .NET runtime and the Windows App SDK, whose licenses and notices must ship with it.
Write-Host '==> Collect third-party licenses' -ForegroundColor Cyan
$packages = (dotnet nuget locals global-packages --list) -replace '^global-packages:\s*', ''
$licenseDir = New-Item -ItemType Directory -Force "$publishDir\licenses"
$libraries = (Get-Content "$publishDir\$productName.deps.json" -Raw | ConvertFrom-Json).libraries.PSObject.Properties.Name
foreach ($library in $libraries -match '^(runtimepack\.Microsoft\.NETCore\.App\.Runtime\.|Microsoft\.WindowsAppSDK\.)') {
    $name, $libraryVersion = ($library -replace '^runtimepack\.', '') -split '/'
    Get-ChildItem "$packages\$($name.ToLowerInvariant())\$libraryVersion" -File |
        Where-Object Name -match '^(license|notice|third-party-notices)\.txt$' |
        ForEach-Object { Copy-Item $_.FullName "$licenseDir\$name.$($_.Name.ToUpperInvariant())" }
}
if (-not (Get-ChildItem $licenseDir)) { throw 'No third-party license files were found in the NuGet package cache.' }

Invoke-Step 'Installer' { & $iscc /Q "/DAppVersion=$version" "/DAppName=$productName" "$root\installer\$productName.iss" }

Write-Host "Installer: $root\artifacts\installer\$productName-$version-Setup.exe" -ForegroundColor Green
