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

$ReportFile = Join-Path $ReportDir "circular.txt"

$Madge = Join-Path `
    $ToolkitRoot `
    "node_modules\.bin\madge.cmd"

if (!(Test-Path $Madge))
{
    "Madge executable was not found." |
        Set-Content $ReportFile

    exit 0
}

try
{
    & $Madge `
        $SourcePath `
        --extensions ts `
        --ts-config $TsConfigPath `
        --circular 2>&1 |
        Out-File $ReportFile -Encoding utf8
}
catch
{
    "Madge failed." |
        Out-File $ReportFile

    $_ |
        Out-File $ReportFile -Append
}

exit 0