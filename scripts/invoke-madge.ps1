param(
    [Parameter(Mandatory = $true)]
    [string]$ToolkitRoot,

    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot,

    [Parameter(Mandatory = $true)]
    [string]$TsConfigPath,

    [Parameter(Mandatory = $true)]
    [string]$ChangedFilesPath,

    [Parameter(Mandatory = $true)]
    [string]$ResultPath,

    [Parameter(Mandatory = $true)]
    [string]$RawOutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$commonScriptPath = Join-Path $PSScriptRoot "common.ps1"

if (-not (Test-Path -LiteralPath $commonScriptPath -PathType Leaf)) {
    throw "Required common script was not found: $commonScriptPath"
}

. $commonScriptPath

function Normalize-QaRepositoryPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $normalized = $Path.Replace('\', '/')
    $normalized = $normalized.Trim()
    $normalized = $normalized.TrimStart('.', '/')

    return $normalized
}

function Get-QaChangedFilesDocument {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $document = Read-QaJson -Path $Path

    if ($document -is [System.Array]) {
        return @(
            $document |
                ForEach-Object {
                    [string]$_
                }
        )
    }

    if ($null -ne $document.PSObject.Properties["files"]) {
        return @(
            $document.files |
                ForEach-Object {
                    [string]$_
                }
        )
    }

    throw "Changed-files JSON must be an array or contain a 'files' property."
}

function Test-QaCycleTouchesChangedFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Cycle,

        [Parameter(Mandatory = $true)]
        [string[]]$ChangedFiles
    )

    foreach ($cycleFile in $Cycle) {
        $normalizedCycleFile = Normalize-QaRepositoryPath `
            -Path $cycleFile

        foreach ($changedFile in $ChangedFiles) {
            $normalizedChangedFile = Normalize-QaRepositoryPath `
                -Path $changedFile

            if (
                $normalizedCycleFile.Equals(
                    $normalizedChangedFile,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            ) {
                return $true
            }

            if (
                $normalizedCycleFile.EndsWith(
                    "/$normalizedChangedFile",
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            ) {
                return $true
            }

            if (
                $normalizedChangedFile.EndsWith(
                    "/$normalizedCycleFile",
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            ) {
                return $true
            }
        }
    }

    return $false
}

function Write-MadgeErrorResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath,

        [Parameter(Mandatory = $false)]
        [int]$ExitCode = 2,

        [Parameter(Mandatory = $false)]
        [int]$DurationMs = 0
    )

    $result = New-QaResult `
        -Tool "Madge" `
        -Category "CIRCULAR_DEPENDENCIES" `
        -Status "ERROR" `
        -Blocking $true `
        -ExitCode $ExitCode `
        -FindingCount 0 `
        -DurationMs $DurationMs `
        -Summary "Circular-dependency analysis could not be completed." `
        -Details @(
            New-QaDetail `
                -Severity "HIGH" `
                -Message $Message `
                -File $null `
                -Line $null `
                -RuleId "madge.execution-error"
        ) `
        -Metadata @{
            analyzer = "madge"
        }

    Write-QaJson `
        -Value $result `
        -Path $OutputPath `
        -ValidateAsQaResult |
        Out-Null
}

$resolvedToolkitRoot = $null
$resolvedRepositoryRoot = $null
$resolvedTsConfigPath = $null
$resolvedChangedFilesPath = $null
$resolvedResultPath = $null
$resolvedRawOutputPath = $null
$processResult = $null

try {
    $resolvedToolkitRoot = Resolve-QaPath `
        -Path $ToolkitRoot

    $resolvedRepositoryRoot = Resolve-QaPath `
        -Path $RepositoryRoot

    $resolvedTsConfigPath = Resolve-QaPath `
        -Path $TsConfigPath `
        -BasePath $resolvedRepositoryRoot

    $resolvedChangedFilesPath = Resolve-QaPath `
        -Path $ChangedFilesPath

    $resolvedResultPath = Resolve-QaPath `
        -Path $ResultPath `
        -AllowMissing

    $resolvedRawOutputPath = Resolve-QaPath `
        -Path $RawOutputPath `
        -AllowMissing

    Write-QaLog `
        -Level "INFO" `
        -Message "Starting circular-dependency analysis for PR-changed TypeScript files."

    $allChangedFiles = @(
        Get-QaChangedFilesDocument `
            -Path $resolvedChangedFilesPath |
            ForEach-Object {
                Normalize-QaRepositoryPath -Path $_
            } |
            Sort-Object -Unique
    )

    $changedTypeScriptFiles = Select-QaChangedFiles `
        -ChangedFiles $allChangedFiles `
        -IncludePatterns @(
            "^src/.+\.(ts|tsx)$"
        ) `
        -ExcludePatterns @(
            "\.d\.ts$",
            "\.(spec|test)\.(ts|tsx)$",
            "(^|/)(__tests__|__mocks__|tests?|fixtures|mocks)(/|$)",
            "(^|/)(generated|dist|build|coverage|reports)(/|$)",
            "(^|/)prisma/migrations(/|$)"
        )

    $existingChangedTypeScriptFiles = New-Object `
        System.Collections.Generic.List[string]

    foreach ($file in $changedTypeScriptFiles) {
        $absoluteFilePath = Resolve-QaPath `
            -Path $file `
            -BasePath $resolvedRepositoryRoot `
            -AllowMissing

        if (Test-Path -LiteralPath $absoluteFilePath -PathType Leaf) {
            $existingChangedTypeScriptFiles.Add($file)
        }
    }

    if ($existingChangedTypeScriptFiles.Count -eq 0) {
        $result = New-QaResult `
            -Tool "Madge" `
            -Category "CIRCULAR_DEPENDENCIES" `
            -Status "SKIPPED" `
            -Blocking $false `
            -ExitCode 0 `
            -FindingCount 0 `
            -DurationMs 0 `
            -Summary "No changed backend TypeScript source files require circular-dependency analysis." `
            -Details @() `
            -Metadata @{
                changedFileCount = $allChangedFiles.Count
                analyzedFileCount = 0
                totalCycleCount = 0
                relevantCycleCount = 0
            }

        Write-QaJson `
            -Value $result `
            -Path $resolvedResultPath `
            -ValidateAsQaResult |
            Out-Null

        Write-QaJson `
            -Value @{
                tool = "Madge"
                skipped = $true
                changedFiles = $allChangedFiles
                analyzedFiles = @()
                cycles = @()
                stdout = ""
                stderr = ""
                exitCode = 0
                durationMs = 0
            } `
            -Path $resolvedRawOutputPath |
            Out-Null

        Write-QaLog `
            -Level "SUCCESS" `
            -Message $result.summary

        exit 0
    }

    $madgeCliCandidates = @(
        (Join-Path $resolvedToolkitRoot "node_modules\madge\bin\cli.js"),
        (Join-Path $resolvedToolkitRoot "node_modules\madge\bin\cli.cjs")
    )

    $madgeCliPath = $madgeCliCandidates |
        Where-Object {
            Test-Path -LiteralPath $_ -PathType Leaf
        } |
        Select-Object -First 1

    if ([string]::IsNullOrWhiteSpace($madgeCliPath)) {
        throw "Madge CLI was not found under: $resolvedToolkitRoot"
    }

    $nodeExecutable = Resolve-QaExecutable `
        -FilePath "node"

    $arguments = @(
        $madgeCliPath,
        "--circular",
        "--json",
        "--extensions",
        "ts,tsx",
        "--ts-config",
        $resolvedTsConfigPath
    )

    $arguments += $existingChangedTypeScriptFiles.ToArray()

    $processResult = Invoke-QaProcess `
        -FilePath $nodeExecutable `
        -Arguments $arguments `
        -WorkingDirectory $resolvedRepositoryRoot `
        -Environment @{
            NO_COLOR = "1"
        } `
        -TimeoutSeconds 600

    $parsedCycles = @()

    if (-not [string]::IsNullOrWhiteSpace($processResult.StandardOut)) {
        try {
            $parsedOutput = $processResult.StandardOut |
                ConvertFrom-Json

            if ($null -ne $parsedOutput) {
                $parsedCycles = @($parsedOutput)
            }
        }
        catch {
            throw @"
Madge returned invalid JSON output.

Exit code: $($processResult.ExitCode)
Parsing error: $($_.Exception.Message)
"@
        }
    }

    # Madge may write informational messages to stderr even when analysis
    # succeeds. The analyzer relies on the process exit code and parsed JSON,
    # not stderr text alone.
    if ($processResult.ExitCode -notin @(0, 1)) {
        $toolError = $processResult.StandardErr.Trim()

        if ([string]::IsNullOrWhiteSpace($toolError)) {
            $toolError = $processResult.StandardOut.Trim()
        }

        if ([string]::IsNullOrWhiteSpace($toolError)) {
            $toolError =
                "Madge exited unexpectedly with code $($processResult.ExitCode)."
        }

        throw $toolError
    }

    $normalizedCycles = New-Object `
        System.Collections.Generic.List[object]

    foreach ($cycleValue in $parsedCycles) {
        $cycle = @(
            $cycleValue |
                ForEach-Object {
                    Normalize-QaRepositoryPath -Path ([string]$_)
                }
        )

        if ($cycle.Count -gt 0) {
            $normalizedCycles.Add($cycle)
        }
    }

    $relevantCycles = New-Object `
        System.Collections.Generic.List[object]

    foreach ($cycle in $normalizedCycles) {
        if (
            Test-QaCycleTouchesChangedFile `
                -Cycle @($cycle) `
                -ChangedFiles $existingChangedTypeScriptFiles.ToArray()
        ) {
            $relevantCycles.Add($cycle)
        }
    }

    Write-QaJson `
        -Value @{
            tool = "Madge"
            command = $nodeExecutable
            arguments = $arguments
            workingDirectory = $resolvedRepositoryRoot
            changedFiles = $allChangedFiles
            analyzedFiles = $existingChangedTypeScriptFiles.ToArray()
            cycles = $normalizedCycles.ToArray()
            relevantCycles = $relevantCycles.ToArray()
            stdout = $processResult.StandardOut
            stderr = $processResult.StandardErr
            exitCode = $processResult.ExitCode
            durationMs = $processResult.DurationMs
        } `
        -Path $resolvedRawOutputPath |
        Out-Null

    $details = New-Object `
        System.Collections.Generic.List[object]

    foreach ($cycle in $relevantCycles) {
        $cycleFiles = @($cycle)
        $cycleDisplay = $cycleFiles -join " -> "

        if ($cycleFiles.Count -gt 0) {
            $cycleDisplay += " -> $($cycleFiles[0])"
        }

        $details.Add(
            (New-QaDetail `
                -Severity "HIGH" `
                -Message "This PR introduces or touches a circular dependency: $cycleDisplay" `
                -File ([string]$cycleFiles[0]) `
                -Line $null `
                -RuleId "madge.circular-dependency")
        )
    }

    if ($relevantCycles.Count -gt 0) {
        $result = New-QaResult `
            -Tool "Madge" `
            -Category "CIRCULAR_DEPENDENCIES" `
            -Status "FAILED" `
            -Blocking $true `
            -ExitCode $processResult.ExitCode `
            -FindingCount $relevantCycles.Count `
            -DurationMs $processResult.DurationMs `
            -Summary "$($relevantCycles.Count) circular dependency cycle(s) involving files changed by this PR were detected." `
            -Details $details.ToArray() `
            -Metadata @{
                changedFileCount = $allChangedFiles.Count
                analyzedFileCount = $existingChangedTypeScriptFiles.Count
                totalCycleCount = $normalizedCycles.Count
                relevantCycleCount = $relevantCycles.Count
                stderrPresent =
                    -not [string]::IsNullOrWhiteSpace(
                        $processResult.StandardErr
                    )
            }

        Write-QaLog `
            -Level "ERROR" `
            -Message $result.summary
    }
    else {
        $result = New-QaResult `
            -Tool "Madge" `
            -Category "CIRCULAR_DEPENDENCIES" `
            -Status "PASSED" `
            -Blocking $false `
            -ExitCode $processResult.ExitCode `
            -FindingCount 0 `
            -DurationMs $processResult.DurationMs `
            -Summary "No circular dependencies involving files changed by this PR were detected." `
            -Details @() `
            -Metadata @{
                changedFileCount = $allChangedFiles.Count
                analyzedFileCount = $existingChangedTypeScriptFiles.Count
                totalCycleCount = $normalizedCycles.Count
                relevantCycleCount = 0
                stderrPresent =
                    -not [string]::IsNullOrWhiteSpace(
                        $processResult.StandardErr
                    )
            }

        Write-QaLog `
            -Level "SUCCESS" `
            -Message $result.summary
    }

    Write-QaJson `
        -Value $result `
        -Path $resolvedResultPath `
        -ValidateAsQaResult |
        Out-Null

    if ($result.blocking) {
        exit 1
    }

    exit 0
}
catch {
    $errorMessage = $_.Exception.Message
    Write-Host ""
    Write-Host "========== FULL ERROR ==========" -ForegroundColor Yellow
    Write-Host $_
    Write-Host $_.ScriptStackTrace
    Write-Host "===============================" -ForegroundColor Yellow
    Write-Host ""
    $durationMs = 0
    $exitCode = 2

    if ($null -ne $processResult) {
        $durationMs = [int]$processResult.DurationMs
        $exitCode = [int]$processResult.ExitCode

        if ($exitCode -eq 0) {
            $exitCode = 2
        }
    }

    Write-QaLog `
        -Level "ERROR" `
        -Message "Madge analysis failed: $errorMessage"

    if (-not [string]::IsNullOrWhiteSpace($resolvedResultPath)) {
        Write-MadgeErrorResult `
            -Message $errorMessage `
            -OutputPath $resolvedResultPath `
            -ExitCode $exitCode `
            -DurationMs $durationMs
    }

    if (-not [string]::IsNullOrWhiteSpace($resolvedRawOutputPath)) {
        Write-QaJson `
            -Value @{
                tool = "Madge"
                error = $errorMessage
                exitCode = $exitCode
                durationMs = $durationMs
                stdout = if ($null -ne $processResult) {
                    $processResult.StandardOut
                }
                else {
                    ""
                }
                stderr = if ($null -ne $processResult) {
                    $processResult.StandardErr
                }
                else {
                    ""
                }
            } `
            -Path $resolvedRawOutputPath |
            Out-Null
    }

    exit 2
}