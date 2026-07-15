param(
    [Parameter(Mandatory = $true)]
    [string]$ToolkitRoot,

    [Parameter(Mandatory = $true)]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [string]$TsConfigPath,

    [Parameter(Mandatory = $true)]
    [string]$ReportDir
)

$ErrorActionPreference = "Continue"

New-Item -ItemType Directory -Force $ReportDir | Out-Null

$ReportFile = Join-Path $ReportDir "architecture.txt"

$DependencyCruiser = Join-Path `
    $ToolkitRoot `
    "node_modules\.bin\depcruise.cmd"

$DependencyCruiserConfig = Join-Path `
    $ToolkitRoot `
    "configs\dependency-cruiser.cjs"

if (!(Test-Path $DependencyCruiser))
{
    "Dependency Cruiser executable was not found." |
        Set-Content $ReportFile

    exit 0
}

if (!(Test-Path $DependencyCruiserConfig))
{
    "Dependency Cruiser configuration was not found." |
        Set-Content $ReportFile

    exit 0
}

try
{
    & $DependencyCruiser `
        $SourcePath `
        --config $DependencyCruiserConfig `
        --ts-config $TsConfigPath `
        --output-type err 2>&1 |
        Out-File $ReportFile -Encoding utf8
}
catch
{
    "Dependency Cruiser failed." |
        Out-File $ReportFile

    $_ |
        Out-File $ReportFile -Append
}

exit 0