param(
    [Parameter(Mandatory = $true)]
    [string]$ToolkitRoot,

    [Parameter(Mandatory = $true)]
    [string]$TsConfigPath,

    [Parameter(Mandatory = $true)]
    [string]$ReportDir
)

$ErrorActionPreference = "Continue"

New-Item -ItemType Directory -Force $ReportDir | Out-Null

$ReportFile = Join-Path $ReportDir "deadcode.txt"

$TsPrune = Join-Path `
    $ToolkitRoot `
    "node_modules\.bin\ts-prune.cmd"

if (!(Test-Path $TsPrune))
{
    "ts-prune executable was not found." |
        Set-Content $ReportFile

    exit 0
}

try
{
    & $TsPrune `
        -p $TsConfigPath 2>&1 |
        Out-File $ReportFile -Encoding utf8
}
catch
{
    "ts-prune failed." |
        Out-File $ReportFile

    $_ |
        Out-File $ReportFile -Append
}

exit 0