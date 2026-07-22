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

function Test-PathIsChanged {
    param(
        [Parameter(Mandatory = $true)]
        [string]$IssueFile,

        [Parameter(Mandatory = $true)]
        [string[]]$ChangedFiles
    )

    $normalizedIssueFile = Normalize-RepositoryPath -Path $IssueFile

    foreach ($changedFile in $ChangedFiles) {
        $normalizedChangedFile = Normalize-RepositoryPath -Path $changedFile

        if (
            $normalizedIssueFile.Equals(
                $normalizedChangedFile,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        ) {
            return $true
        }
    }

    return $false
}

function Get-KnipIssueMessage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$IssueType,

        [Parameter(Mandatory = $true)]
        [object]$Issue,

        [Parameter(Mandatory = $true)]
        [string]$File
    )

    $name = if (
        $null -ne $Issue.PSObject.Properties["name"] -and
        -not [string]::IsNullOrWhiteSpace([string]$Issue.name)
    ) {
        [string]$Issue.name
    }
    else {
        $File
    }

    switch ($IssueType) {
        "files" {
            return "Possible unused file introduced or modified by this PR: $name"
        }

        "dependencies" {
            return "Possible unused dependency: $name"
        }

        "devDependencies" {
            return "Possible unused development dependency: $name"
        }

        "optionalPeerDependencies" {
            return "Possible unused optional peer dependency: $name"
        }

        "unlisted" {
            return "Dependency is used but is not listed in package.json: $name"
        }

        "unresolved" {
            return "Import or dependency could not be resolved: $name"
        }

        "exports" {
            return "Possible unused export: $name"
        }

        "types" {
            return "Possible unused exported type: $name"
        }

        "enumMembers" {
            return "Possible unused enum member: $name"
        }

        "classMembers" {
            return "Possible unused class member: $name"
        }

        "duplicates" {
            return "Duplicate export detected: $name"
        }

        "catalog" {
            return "Possible unused catalog entry: $name"
        }

        default {
            return "Knip reported a possible unused-code issue ($IssueType): $name"
        }
    }
}

function Get-KnipSeverity {
    param(
        [Parameter(Mandatory = $true)]
        [string]$IssueType
    )

    switch ($IssueType) {
        "unlisted" {
            return "MEDIUM"
        }

        "unresolved" {
            return "MEDIUM"
        }

        default {
            return "LOW"
        }
    }
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
        -Message "Starting PR unused-code analysis."

    $changedFilesDocument = Read-QaJson `
        -Path $resolvedChangedFilesPath

    $allChangedFiles = @()

    if ($changedFilesDocument -is [System.Array]) {
        $allChangedFiles = @($changedFilesDocument)
    }
    elseif ($null -ne $changedFilesDocument.PSObject.Properties["files"]) {
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

    $changedSourceFiles = @(
        $normalizedChangedFiles |
            Where-Object {
                $_ -match "^src/.+\.(ts|tsx|js|jsx)$" -and
                $_ -notmatch "\.d\.ts$" -and
                $_ -notmatch "\.(spec|test)\.(ts|tsx|js|jsx)$" -and
                $_ -notmatch "(^|/)(test|tests|__tests__|fixtures|mocks)/" -and
                $_ -notmatch "(^|/)generated/" -and
                $_ -notmatch "(^|/)prisma/migrations/"
            }
    )

    $dependencyFilesChanged = @(
        $normalizedChangedFiles |
            Where-Object {
                $_ -in @(
                    "package.json",
                    "package-lock.json",
                    "npm-shrinkwrap.json"
                )
            }
    ).Count -gt 0

    if (
        $changedSourceFiles.Count -eq 0 -and
        -not $dependencyFilesChanged
    ) {
        $result = New-QaResult `
            -Tool "Knip" `
            -Category "UNUSED_CODE" `
            -Status "SKIPPED" `
            -Blocking $false `
            -ExitCode 0 `
            -FindingCount 0 `
            -DurationMs 0 `
            -Summary "No changed source or dependency files require unused-code analysis." `
            -Details @() `
            -Metadata @{
                changedFileCount = $normalizedChangedFiles.Count
                relevantChangedFileCount = 0
            }

        Write-QaJson `
            -Value $result `
            -Path $resolvedResultPath |
            Out-Null

        Write-QaJson `
            -Value @{
                tool = "Knip"
                skipped = $true
                changedFiles = $normalizedChangedFiles
                relevantChangedFiles = @()
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

    # Run Knip through Node directly instead of the Windows .cmd shim.
    # This avoids cmd.exe quoting/output-capture problems in redirected processes.
    $knipCliPath = Join-Path `
        $resolvedToolkitRoot `
        "node_modules\knip\bin\knip.js"

    if (-not (Test-Path -LiteralPath $knipCliPath -PathType Leaf)) {
        throw "Knip CLI was not found: $knipCliPath"
    }

    $nodeExecutable = Resolve-QaExecutable `
        -FilePath "node"

    $arguments = @(
        $knipCliPath,
        "--config",
        $resolvedConfigPath,
        "--directory",
        $resolvedRepositoryRoot,
        "--reporter",
        "json",
        "--no-progress",
        "--no-config-hints"
    )

    $processResult = Invoke-QaProcess `
        -FilePath $nodeExecutable `
        -Arguments $arguments `
        -WorkingDirectory $resolvedRepositoryRoot `
        -Environment @{
            NO_COLOR = "1"
        } `
        -TimeoutSeconds 900

    $rawDocument = [ordered]@{
        tool = "Knip"
        command = $nodeExecutable
        cliPath = $knipCliPath
        arguments = $arguments
        workingDirectory = $resolvedRepositoryRoot
        changedFiles = $normalizedChangedFiles
        relevantChangedFiles = $changedSourceFiles
        dependencyFilesChanged = $dependencyFilesChanged
        exitCode = $processResult.ExitCode
        durationMs = $processResult.DurationMs
        stdout = $processResult.StandardOut
        stderr = $processResult.StandardErr
    }

    Write-QaJson `
        -Value $rawDocument `
        -Path $resolvedRawOutputPath |
        Out-Null

    # Knip exit codes:
    # 0 = successful run with no lint issues
    # 1 = successful run with lint issues
    # 2 = Knip execution/configuration error
    if ($processResult.ExitCode -eq 2) {
        $toolError = $processResult.StandardErr.Trim()

        if ([string]::IsNullOrWhiteSpace($toolError)) {
            $toolError = $processResult.StandardOut.Trim()
        }

        if ([string]::IsNullOrWhiteSpace($toolError)) {
            $toolError = "Knip failed with exit code 2."
        }

        throw $toolError
    }

    if ($processResult.ExitCode -notin @(0, 1)) {
        $toolError = $processResult.StandardErr.Trim()

        if ([string]::IsNullOrWhiteSpace($toolError)) {
            $toolError = "Knip exited unexpectedly with code $($processResult.ExitCode)."
        }

        throw $toolError
    }

    $knipOutput = $null

    if ([string]::IsNullOrWhiteSpace($processResult.StandardOut)) {
        if ($processResult.ExitCode -eq 0) {
            $knipOutput = [pscustomobject]@{
                issues = @()
            }
        }
        else {
            throw "Knip reported findings but returned no JSON output."
        }
    }
    else {
        try {
            $knipOutput = $processResult.StandardOut |
                ConvertFrom-Json
        }
        catch {
            throw @"
Knip returned output that could not be parsed as JSON.
Exit code: $($processResult.ExitCode)
Error: $($_.Exception.Message)
"@
        }
    }

    if ($null -eq $knipOutput.PSObject.Properties["issues"]) {
        throw "Knip JSON output does not contain the expected 'issues' array."
    }

    $ignoredProperties = @(
        "file",
        "owners"
    )

    $relevantDetails = New-Object System.Collections.Generic.List[object]
    $relevantIssueTypes = @{}
    $totalKnipFindingCount = 0

    foreach ($issueGroup in @($knipOutput.issues)) {
        if ($null -eq $issueGroup) {
            continue
        }

        $issueFile = if (
            $null -ne $issueGroup.PSObject.Properties["file"]
        ) {
            Normalize-RepositoryPath -Path ([string]$issueGroup.file)
        }
        else {
            ""
        }

        $isChangedSourceFile = (
            -not [string]::IsNullOrWhiteSpace($issueFile) -and
            (Test-PathIsChanged `
                -IssueFile $issueFile `
                -ChangedFiles $changedSourceFiles)
        )

        $isDependencyManifest = (
            $issueFile -in @(
                "package.json",
                "package-lock.json",
                "npm-shrinkwrap.json"
            )
        )

        foreach ($property in $issueGroup.PSObject.Properties) {
            $issueType = [string]$property.Name

            if ($issueType -in $ignoredProperties) {
                continue
            }

            $issues = @($property.Value)

            foreach ($issue in $issues) {
                if ($null -eq $issue) {
                    continue
                }

                $totalKnipFindingCount++

                $isRelevant = $false

                if ($isChangedSourceFile) {
                    $isRelevant = $true
                }
                elseif (
                    $isDependencyManifest -and
                    $dependencyFilesChanged
                ) {
                    $isRelevant = $true
                }
                elseif (
                    $issueType -eq "files" -and
                    $null -ne $issue.PSObject.Properties["name"]
                ) {
                    $reportedFile = Normalize-RepositoryPath `
                        -Path ([string]$issue.name)

                    $isRelevant = Test-PathIsChanged `
                        -IssueFile $reportedFile `
                        -ChangedFiles $changedSourceFiles

                    if ($isRelevant) {
                        $issueFile = $reportedFile
                    }
                }

                if (-not $isRelevant) {
                    continue
                }

                $severity = Get-KnipSeverity `
                    -IssueType $issueType

                $message = Get-KnipIssueMessage `
                    -IssueType $issueType `
                    -Issue $issue `
                    -File $issueFile

                $line = $null

                if (
                    $null -ne $issue.PSObject.Properties["line"] -and
                    $null -ne $issue.line
                ) {
                    $line = [int]$issue.line
                }

                $detail = New-QaDetail `
                    -Severity $severity `
                    -Message $message `
                    -File $issueFile `
                    -Line $line `
                    -RuleId "knip.$issueType"

                $relevantDetails.Add($detail)

                if (-not $relevantIssueTypes.ContainsKey($issueType)) {
                    $relevantIssueTypes[$issueType] = 0
                }

                $relevantIssueTypes[$issueType]++
            }
        }
    }

    $findingCount = $relevantDetails.Count

    if ($findingCount -gt 0) {
        $result = New-QaResult `
            -Tool "Knip" `
            -Category "UNUSED_CODE" `
            -Status "WARNING" `
            -Blocking $false `
            -ExitCode $processResult.ExitCode `
            -FindingCount $findingCount `
            -DurationMs $processResult.DurationMs `
            -Summary "$findingCount possible unused-code or dependency issue(s) related to this PR require developer review." `
            -Details $relevantDetails.ToArray() `
            -Metadata @{
                changedFileCount = $normalizedChangedFiles.Count
                analyzedChangedSourceFileCount = $changedSourceFiles.Count
                dependencyFilesChanged = $dependencyFilesChanged
                totalRepositoryFindingCount = $totalKnipFindingCount
                relevantIssueTypes = $relevantIssueTypes
            }

        Write-QaLog `
            -Level "WARNING" `
            -Message $result.summary
    }
    else {
        $result = New-QaResult `
            -Tool "Knip" `
            -Category "UNUSED_CODE" `
            -Status "PASSED" `
            -Blocking $false `
            -ExitCode $processResult.ExitCode `
            -FindingCount 0 `
            -DurationMs $processResult.DurationMs `
            -Summary "No unused-code findings directly related to files changed by this PR were detected." `
            -Details @() `
            -Metadata @{
                changedFileCount = $normalizedChangedFiles.Count
                analyzedChangedSourceFileCount = $changedSourceFiles.Count
                dependencyFilesChanged = $dependencyFilesChanged
                totalRepositoryFindingCount = $totalKnipFindingCount
                relevantIssueTypes = @{}
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

    # Knip findings are advisory in this PR workflow.
    exit 0
}
catch {
    $errorMessage = $_.Exception.Message

    Write-QaLog `
        -Level "ERROR" `
        -Message "Knip analysis failed: $errorMessage"

    $errorResult = New-QaResult `
        -Tool "Knip" `
        -Category "UNUSED_CODE" `
        -Status "ERROR" `
        -Blocking $true `
        -ExitCode 2 `
        -FindingCount 0 `
        -DurationMs 0 `
        -Summary "Unused-code analysis could not be completed." `
        -Details @(
            New-QaDetail `
                -Severity "HIGH" `
                -Message $errorMessage `
                -File $null `
                -Line $null `
                -RuleId "knip.execution-error"
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
                tool = "Knip"
                error = $errorMessage
            } `
            -Path $resolvedRawOutputPath |
            Out-Null
    }

    exit 2
}