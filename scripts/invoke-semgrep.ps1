param(
    [Parameter(Mandatory = $true)]
    [string]$ToolkitRoot,

    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot,

    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $true)]
    [string]$ChangedFilesPath,

    [Parameter(Mandatory = $true)]
    [string]$ResultPath,

    [Parameter(Mandatory = $true)]
    [string]$RawOutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$commonScript = Join-Path $PSScriptRoot "common.ps1"

if (-not (Test-Path -LiteralPath $commonScript)) {
    throw "Required common script was not found: $commonScript"
}

. $commonScript

function Normalize-RepositoryPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $normalized = $Path.Replace('\', '/')
    $normalized = $normalized.TrimStart('.', '/')
    $normalized = $normalized.Trim()

    return $normalized
}

function Get-SemgrepSeverity {
    param(
        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [string]$Severity
    )

    switch (($Severity ?? "").ToUpperInvariant()) {
        "ERROR" {
            return "HIGH"
        }

        "WARNING" {
            return "MEDIUM"
        }

        "INFO" {
            return "LOW"
        }

        default {
            return "MEDIUM"
        }
    }
}

function Test-SemgrepFindingIsBlocking {
    param(
        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [string]$Severity,

        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [object]$Metadata
    )

    if (($Severity ?? "").ToUpperInvariant() -ne "ERROR") {
        return $false
    }

    if ($null -eq $Metadata) {
        return $true
    }

    $confidence = ""

    if ($null -ne $Metadata.PSObject.Properties["confidence"]) {
        $confidence = ([string]$Metadata.confidence).ToUpperInvariant()
    }

    if ([string]::IsNullOrWhiteSpace($confidence)) {
        return $true
    }

    return $confidence -in @(
        "HIGH",
        "VERY HIGH"
    )
}

function Get-SemgrepMessage {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Finding
    )

    if (
        $null -ne $Finding.extra -and
        $null -ne $Finding.extra.PSObject.Properties["message"] -and
        -not [string]::IsNullOrWhiteSpace([string]$Finding.extra.message)
    ) {
        return ([string]$Finding.extra.message).Trim()
    }

    return "Semgrep detected a security or code-quality concern."
}

$resolvedToolkitRoot = $null
$resolvedRepositoryRoot = $null
$resolvedConfigPath = $null
$resolvedChangedFilesPath = $null
$resolvedResultPath = $null
$resolvedRawOutputPath = $null

try {
    $resolvedToolkitRoot = Resolve-QaPath `
        -Path $ToolkitRoot

    $resolvedRepositoryRoot = Resolve-QaPath `
        -Path $RepositoryRoot

    $resolvedConfigPath = Resolve-QaPath `
        -Path $ConfigPath `
        -BasePath $resolvedToolkitRoot

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
        -Message "Starting PR-focused Semgrep analysis."

    $changedFilesDocument = Read-QaJson `
        -Path $resolvedChangedFilesPath

    $allChangedFiles = @()

    if ($changedFilesDocument -is [System.Array]) {
        $allChangedFiles = @($changedFilesDocument)
    }
    elseif (
        $null -ne $changedFilesDocument.PSObject.Properties["files"]
    ) {
        $allChangedFiles = @($changedFilesDocument.files)
    }
    else {
        throw "Changed-files JSON must be an array or contain a 'files' property."
    }

    $normalizedChangedFiles = @(
        $allChangedFiles |
            ForEach-Object {
                Normalize-RepositoryPath -Path ([string]$_)
            } |
            Sort-Object -Unique
    )

    $changedScannableFiles = @(
        foreach ($file in $normalizedChangedFiles) {
            if (
                $file -notmatch "^src/.+\.(ts|tsx|js|jsx)$" -or
                $file -match "\.d\.ts$" -or
                $file -match "(^|/)(generated|coverage|dist|build)/" -or
                $file -match "(^|/)prisma/migrations/"
            ) {
                continue
            }

            $absoluteFile = Resolve-QaPath `
                -Path $file `
                -BasePath $resolvedRepositoryRoot `
                -AllowMissing

            if (Test-Path -LiteralPath $absoluteFile -PathType Leaf) {
                $file
            }
        }
    )

    if ($changedScannableFiles.Count -eq 0) {
        $result = New-QaResult `
            -Tool "Semgrep" `
            -Category "SECURITY" `
            -Status "SKIPPED" `
            -Blocking $false `
            -ExitCode 0 `
            -FindingCount 0 `
            -DurationMs 0 `
            -Summary "No changed backend source files require security analysis." `
            -Details @() `
            -Metadata @{
                changedFileCount = $normalizedChangedFiles.Count
                analyzedFileCount = 0
                blockingFindingCount = 0
                advisoryFindingCount = 0
            }

        Write-QaJson `
            -Value $result `
            -Path $resolvedResultPath |
            Out-Null

        Write-QaJson `
            -Value @{
                tool = "Semgrep"
                skipped = $true
                changedFiles = $normalizedChangedFiles
                analyzedFiles = @()
                stdout = ""
                stderr = ""
            } `
            -Path $resolvedRawOutputPath |
            Out-Null

        Write-QaLog `
            -Level "SUCCESS" `
            -Message $result.summary

        exit 0
    }

    $semgrepExecutable = $null
    $semgrepArgumentsPrefix = @()

    $semgrepCommand = Get-Command `
        -Name "semgrep" `
        -ErrorAction SilentlyContinue

    if ($null -ne $semgrepCommand) {
        $semgrepExecutable = $semgrepCommand.Source
    }
    else {
        $pythonCommand = Get-Command `
            -Name "python" `
            -ErrorAction SilentlyContinue

        if ($null -eq $pythonCommand) {
            $pythonCommand = Get-Command `
                -Name "python3" `
                -ErrorAction SilentlyContinue
        }

        if ($null -eq $pythonCommand) {
            throw "Neither Semgrep nor Python was found on the runner."
        }

        $semgrepExecutable = $pythonCommand.Source
        $semgrepArgumentsPrefix = @(
            "-m",
            "semgrep"
        )
    }

    $arguments = @()
    $arguments += $semgrepArgumentsPrefix
    $arguments += @(
        "scan",
        "--config",
        $resolvedConfigPath,
        "--json",
        "--quiet",
        "--no-rewrite-rule-ids",
        "--metrics",
        "off"
    )

    $arguments += $changedScannableFiles

    $processResult = Invoke-QaProcess `
        -FilePath $semgrepExecutable `
        -Arguments $arguments `
        -WorkingDirectory $resolvedRepositoryRoot `
        -Environment @{
            NO_COLOR = "1"
            SEMGREP_SEND_METRICS = "off"
        } `
        -TimeoutSeconds 900

    $rawDocument = [ordered]@{
        tool = "Semgrep"
        command = $semgrepExecutable
        arguments = $arguments
        workingDirectory = $resolvedRepositoryRoot
        changedFiles = $normalizedChangedFiles
        analyzedFiles = $changedScannableFiles
        exitCode = $processResult.ExitCode
        durationMs = $processResult.DurationMs
        stdout = $processResult.StandardOut
        stderr = $processResult.StandardErr
    }

    Write-QaJson `
        -Value $rawDocument `
        -Path $resolvedRawOutputPath |
        Out-Null

    if ($processResult.ExitCode -ne 0) {
        $toolError = $processResult.StandardErr.Trim()

        if ([string]::IsNullOrWhiteSpace($toolError)) {
            $toolError = $processResult.StandardOut.Trim()
        }

        if ([string]::IsNullOrWhiteSpace($toolError)) {
            $toolError = "Semgrep exited unexpectedly with code $($processResult.ExitCode)."
        }

        throw $toolError
    }

    if ([string]::IsNullOrWhiteSpace($processResult.StandardOut)) {
        throw "Semgrep completed without returning the expected JSON output."
    }

    try {
        $semgrepOutput = $processResult.StandardOut |
            ConvertFrom-Json
    }
    catch {
        throw @"
Semgrep returned output that could not be parsed as JSON.
Exit code: $($processResult.ExitCode)
Error: $($_.Exception.Message)
"@
    }

    if (
        $null -eq $semgrepOutput.PSObject.Properties["results"]
    ) {
        throw "Semgrep JSON output does not contain the expected 'results' property."
    }

    $details = New-Object System.Collections.Generic.List[object]
    $blockingFindingCount = 0
    $advisoryFindingCount = 0
    $severityCounts = @{
        INFO = 0
        LOW = 0
        MEDIUM = 0
        HIGH = 0
        CRITICAL = 0
    }

    foreach ($finding in @($semgrepOutput.results)) {
        if ($null -eq $finding) {
            continue
        }

        $findingPath = Normalize-RepositoryPath `
            -Path ([string]$finding.path)

        if ($findingPath -notin $changedScannableFiles) {
            continue
        }

        $semgrepSeverity = ""

        if (
            $null -ne $finding.extra -and
            $null -ne $finding.extra.PSObject.Properties["severity"]
        ) {
            $semgrepSeverity = [string]$finding.extra.severity
        }

        $qaSeverity = Get-SemgrepSeverity `
            -Severity $semgrepSeverity

        $metadata = $null

        if (
            $null -ne $finding.extra -and
            $null -ne $finding.extra.PSObject.Properties["metadata"]
        ) {
            $metadata = $finding.extra.metadata
        }

        $blocking = Test-SemgrepFindingIsBlocking `
            -Severity $semgrepSeverity `
            -Metadata $metadata

        if ($blocking) {
            $blockingFindingCount++
        }
        else {
            $advisoryFindingCount++
        }

        if ($severityCounts.ContainsKey($qaSeverity)) {
            $severityCounts[$qaSeverity]++
        }

        $line = $null

        if (
            $null -ne $finding.start -and
            $null -ne $finding.start.PSObject.Properties["line"]
        ) {
            $line = [int]$finding.start.line
        }

        $ruleId = $null

        if ($null -ne $finding.PSObject.Properties["check_id"]) {
            $ruleId = [string]$finding.check_id
        }

        $message = Get-SemgrepMessage `
            -Finding $finding

        $details.Add(
            (New-QaDetail `
                -Severity $qaSeverity `
                -Message $message `
                -File $findingPath `
                -Line $line `
                -RuleId $ruleId)
        )
    }

    $findingCount = $details.Count

    if ($blockingFindingCount -gt 0) {
        $result = New-QaResult `
            -Tool "Semgrep" `
            -Category "SECURITY" `
            -Status "FAILED" `
            -Blocking $true `
            -ExitCode $processResult.ExitCode `
            -FindingCount $findingCount `
            -DurationMs $processResult.DurationMs `
            -Summary "$blockingFindingCount blocking security finding(s) were introduced in files changed by this PR." `
            -Details $details.ToArray() `
            -Metadata @{
                changedFileCount = $normalizedChangedFiles.Count
                analyzedFileCount = $changedScannableFiles.Count
                blockingFindingCount = $blockingFindingCount
                advisoryFindingCount = $advisoryFindingCount
                severityCounts = $severityCounts
            }

        Write-QaLog `
            -Level "ERROR" `
            -Message $result.summary
    }
    elseif ($findingCount -gt 0) {
        $result = New-QaResult `
            -Tool "Semgrep" `
            -Category "SECURITY" `
            -Status "WARNING" `
            -Blocking $false `
            -ExitCode $processResult.ExitCode `
            -FindingCount $findingCount `
            -DurationMs $processResult.DurationMs `
            -Summary "$findingCount non-blocking security or code-quality finding(s) in files changed by this PR require review." `
            -Details $details.ToArray() `
            -Metadata @{
                changedFileCount = $normalizedChangedFiles.Count
                analyzedFileCount = $changedScannableFiles.Count
                blockingFindingCount = 0
                advisoryFindingCount = $advisoryFindingCount
                severityCounts = $severityCounts
            }

        Write-QaLog `
            -Level "WARNING" `
            -Message $result.summary
    }
    else {
        $result = New-QaResult `
            -Tool "Semgrep" `
            -Category "SECURITY" `
            -Status "PASSED" `
            -Blocking $false `
            -ExitCode $processResult.ExitCode `
            -FindingCount 0 `
            -DurationMs $processResult.DurationMs `
            -Summary "No new Semgrep findings were detected in files changed by this PR." `
            -Details @() `
            -Metadata @{
                changedFileCount = $normalizedChangedFiles.Count
                analyzedFileCount = $changedScannableFiles.Count
                blockingFindingCount = 0
                advisoryFindingCount = 0
                severityCounts = $severityCounts
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

    if ($result.Blocking) {
        exit 1
    }

    exit 0
}
catch {
    $errorMessage = $_.Exception.Message

    Write-QaLog `
        -Level "ERROR" `
        -Message "Semgrep analysis failed: $errorMessage"

    $errorResult = New-QaResult `
        -Tool "Semgrep" `
        -Category "SECURITY" `
        -Status "ERROR" `
        -Blocking $true `
        -ExitCode 2 `
        -FindingCount 0 `
        -DurationMs 0 `
        -Summary "Security analysis could not be completed." `
        -Details @(
            New-QaDetail `
                -Severity "HIGH" `
                -Message $errorMessage `
                -File $null `
                -Line $null `
                -RuleId "semgrep.execution-error"
        ) `
        -Metadata @{}

    if (-not [string]::IsNullOrWhiteSpace($resolvedResultPath)) {
        Write-QaJson `
            -Value $errorResult `
            -Path $resolvedResultPath `
            -ValidateAsQaResult |
            Out-Null
    }

    if (-not [string]::IsNullOrWhiteSpace($resolvedRawOutputPath)) {
        Write-QaJson `
            -Value @{
                tool = "Semgrep"
                error = $errorMessage
            } `
            -Path $resolvedRawOutputPath |
            Out-Null
    }

    exit 2
}