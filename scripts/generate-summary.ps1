param(
    [Parameter(Mandatory = $true)]
    [string]$ResultsDirectory,

    [Parameter(Mandatory = $true)]
    [string]$SummaryPath,

    [Parameter(Mandatory = $false)]
    [string]$ChangedFilesPath = "",

    [Parameter(Mandatory = $false)]
    [ValidateRange(1, 100)]
    [int]$MaximumDisplayedFindingsPerTool = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$commonScriptPath = Join-Path $PSScriptRoot "common.ps1"

if (-not (Test-Path -LiteralPath $commonScriptPath -PathType Leaf)) {
    throw "Required common script was not found: $commonScriptPath"
}

. $commonScriptPath

function Get-QaStatusLabel {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet(
            "PASSED",
            "WARNING",
            "FAILED",
            "SKIPPED",
            "ERROR"
        )]
        [string]$Status
    )

    switch ($Status) {
        "PASSED" {
            return "Passed"
        }

        "WARNING" {
            return "Review suggested"
        }

        "FAILED" {
            return "Fix required"
        }

        "SKIPPED" {
            return "Not applicable"
        }

        "ERROR" {
            return "Tool error"
        }
    }
}

function Get-QaStatusSymbol {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet(
            "PASSED",
            "WARNING",
            "FAILED",
            "SKIPPED",
            "ERROR"
        )]
        [string]$Status
    )

    switch ($Status) {
        "PASSED" {
            return "[PASS]"
        }

        "WARNING" {
            return "[WARN]"
        }

        "FAILED" {
            return "[FAIL]"
        }

        "SKIPPED" {
            return "[SKIP]"
        }

        "ERROR" {
            return "[ERROR]"
        }
    }
}

function Get-QaCategoryDisplayName {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet(
            "SECURITY",
            "CIRCULAR_DEPENDENCIES",
            "UNUSED_CODE"
        )]
        [string]$Category
    )

    switch ($Category) {
        "SECURITY" {
            return "Security"
        }

        "CIRCULAR_DEPENDENCIES" {
            return "Circular dependencies"
        }

        "UNUSED_CODE" {
            return "Unused code"
        }
    }
}

function Get-QaOverallStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Results
    )

    if (
        @(
            $Results |
                Where-Object {
                    $_.status -eq "ERROR"
                }
        ).Count -gt 0
    ) {
        return "ERROR"
    }

    if (
        @(
            $Results |
                Where-Object {
                    $_.status -eq "FAILED" -or
                    $_.blocking -eq $true
                }
        ).Count -gt 0
    ) {
        return "FAILED"
    }

    if (
        @(
            $Results |
                Where-Object {
                    $_.status -eq "WARNING"
                }
        ).Count -gt 0
    ) {
        return "WARNING"
    }

    if (
        @(
            $Results |
                Where-Object {
                    $_.status -eq "PASSED"
                }
        ).Count -gt 0
    ) {
        return "PASSED"
    }

    return "SKIPPED"
}

function Get-QaOverallTitle {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet(
            "PASSED",
            "WARNING",
            "FAILED",
            "SKIPPED",
            "ERROR"
        )]
        [string]$Status
    )

    switch ($Status) {
        "PASSED" {
            return "READY TO PROCEED"
        }

        "WARNING" {
            return "PASSED WITH SUGGESTIONS"
        }

        "FAILED" {
            return "FIX REQUIRED"
        }

        "ERROR" {
            return "QA TOOLING ERROR"
        }

        "SKIPPED" {
            return "NO RELEVANT CHANGES"
        }
    }
}

function Get-QaRecommendation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet(
            "PASSED",
            "WARNING",
            "FAILED",
            "SKIPPED",
            "ERROR"
        )]
        [string]$Status
    )

    switch ($Status) {
        "PASSED" {
            return "No blocking PR issues were detected. The Pull Request may proceed to normal code review."
        }

        "WARNING" {
            return "No blocking PR issues were detected. Review the advisory findings before merging."
        }

        "FAILED" {
            return "Do not merge yet. Fix the blocking findings, push the changes, and allow the checks to rerun."
        }

        "ERROR" {
            return "Do not rely on this result. One or more QA tools could not complete successfully."
        }

        "SKIPPED" {
            return "No relevant backend source changes were found for the configured PR analyzers."
        }
    }
}

function Convert-ToQaDisplayPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    return $Path.Replace("\", "/")
}

function Convert-ToQaSafeTableText {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    $safeValue = $Value.Replace("|", "\|")
    $safeValue = $safeValue.Replace("`r", " ")
    $safeValue = $safeValue.Replace("`n", " ")

    return $safeValue
}

function Add-QaResultDetails {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Lines,

        [Parameter(Mandatory = $true)]
        [object]$Result,

        [Parameter(Mandatory = $true)]
        [ValidateRange(1, 100)]
        [int]$MaximumFindings
    )

    $details = @($Result.details)

    if ($details.Count -eq 0) {
        return
    }

    $displayCount = [Math]::Min(
        $details.Count,
        $MaximumFindings
    )

    $Lines.Add("")
    $Lines.Add("### Findings")
    $Lines.Add("")

    for ($index = 0; $index -lt $displayCount; $index++) {
        $detail = $details[$index]

        $severity = [string]$detail.severity
        $message = [string]$detail.message

        $file = Convert-ToQaDisplayPath `
            -Path ([string]$detail.file)

        $line = $null

        if ($null -ne $detail.line) {
            $line = [int]$detail.line
        }

        $ruleId = ""

        if (-not [string]::IsNullOrWhiteSpace([string]$detail.ruleId)) {
            $ruleId = [string]$detail.ruleId
        }

        $location = ""

        if (-not [string]::IsNullOrWhiteSpace($file)) {
            $location = $file

            if ($null -ne $line) {
                $location = "$location`:$line"
            }
        }

        $findingLine = "- **$severity** - $message"

        if (-not [string]::IsNullOrWhiteSpace($location)) {
            $findingLine += ' (' + [char]96 + $location + [char]96 + ')'
        }

        if (-not [string]::IsNullOrWhiteSpace($ruleId)) {
            $findingLine += ' — Rule: ' + [char]96 + $ruleId + [char]96
        }

        $Lines.Add($findingLine)
    }

    if ($details.Count -gt $displayCount) {
        $remainingCount = $details.Count - $displayCount

        $Lines.Add("")
        $Lines.Add(
            "_$remainingCount additional finding(s) are available in the uploaded QA artifacts._"
        )
    }
}

function New-QaMissingResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Tool,

        [Parameter(Mandatory = $true)]
        [ValidateSet(
            "SECURITY",
            "CIRCULAR_DEPENDENCIES",
            "UNUSED_CODE"
        )]
        [string]$Category,

        [Parameter(Mandatory = $true)]
        [string]$ResultFileName
    )

    return New-QaResult `
        -Tool $Tool `
        -Category $Category `
        -Status "ERROR" `
        -Blocking $true `
        -ExitCode 2 `
        -FindingCount 0 `
        -DurationMs 0 `
        -Summary "$Tool did not produce an analyzer result." `
        -Details @(
            New-QaDetail `
                -Severity "HIGH" `
                -Message "Expected result file was not generated: $ResultFileName" `
                -File $null `
                -Line $null `
                -RuleId "qa.missing-result"
        ) `
        -Metadata @{
            resultFile = $ResultFileName
        }
}

function New-QaInvalidResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Tool,

        [Parameter(Mandatory = $true)]
        [ValidateSet(
            "SECURITY",
            "CIRCULAR_DEPENDENCIES",
            "UNUSED_CODE"
        )]
        [string]$Category,

        [Parameter(Mandatory = $true)]
        [string]$ResultFileName,

        [Parameter(Mandatory = $true)]
        [string]$ErrorMessage
    )

    return New-QaResult `
        -Tool $Tool `
        -Category $Category `
        -Status "ERROR" `
        -Blocking $true `
        -ExitCode 2 `
        -FindingCount 0 `
        -DurationMs 0 `
        -Summary "$Tool produced an invalid analyzer result." `
        -Details @(
            New-QaDetail `
                -Severity "HIGH" `
                -Message "$ResultFileName could not be read or validated: $ErrorMessage" `
                -File $ResultFileName `
                -Line $null `
                -RuleId "qa.invalid-result"
        ) `
        -Metadata @{
            resultFile = $ResultFileName
        }
}

$resolvedResultsDirectory = $null
$resolvedSummaryPath = $null
$resolvedChangedFilesPath = $null

try {
    $resolvedResultsDirectory = Resolve-QaPath `
        -Path $ResultsDirectory

    $resolvedSummaryPath = Resolve-QaPath `
        -Path $SummaryPath `
        -AllowMissing

    if (-not [string]::IsNullOrWhiteSpace($ChangedFilesPath)) {
        $resolvedChangedFilesPath = Resolve-QaPath `
            -Path $ChangedFilesPath
    }

    Write-QaLog `
        -Level "INFO" `
        -Message "Generating the developer-friendly PR quality summary."

    $expectedResults = @(
        @{
            FileName = "madge-result.json"
            Tool = "Madge"
            Category = "CIRCULAR_DEPENDENCIES"
        },
        @{
            FileName = "knip-result.json"
            Tool = "Knip"
            Category = "UNUSED_CODE"
        },
        @{
            FileName = "semgrep-result.json"
            Tool = "Semgrep"
            Category = "SECURITY"
        }
    )

    $results = New-Object `
        System.Collections.Generic.List[object]

    foreach ($expectedResult in $expectedResults) {
        $resultFilePath = Join-Path `
            -Path $resolvedResultsDirectory `
            -ChildPath $expectedResult.FileName

        if (-not (Test-Path -LiteralPath $resultFilePath -PathType Leaf)) {
            $missingResult = New-QaMissingResult `
                -Tool $expectedResult.Tool `
                -Category $expectedResult.Category `
                -ResultFileName $expectedResult.FileName

            $results.Add(
                [pscustomobject]$missingResult
            )

            continue
        }

        try {
            $result = Read-QaJson `
                -Path $resultFilePath `
                -ValidateAsQaResult

            $results.Add($result)
        }
        catch {
            $invalidResult = New-QaInvalidResult `
                -Tool $expectedResult.Tool `
                -Category $expectedResult.Category `
                -ResultFileName $expectedResult.FileName `
                -ErrorMessage $_.Exception.Message

            $results.Add(
                [pscustomobject]$invalidResult
            )
        }
    }

    $changedFiles = @()

    if (-not [string]::IsNullOrWhiteSpace($resolvedChangedFilesPath)) {
        try {
            $changedFilesDocument = Read-QaJson `
                -Path $resolvedChangedFilesPath

            if ($changedFilesDocument -is [System.Array]) {
                $changedFiles = @(
                    $changedFilesDocument |
                        ForEach-Object {
                            [string]$_
                        }
                )
            }
            elseif (
                $null -ne
                $changedFilesDocument.PSObject.Properties["files"]
            ) {
                $changedFiles = @(
                    $changedFilesDocument.files |
                        ForEach-Object {
                            [string]$_
                        }
                )
            }
            else {
                throw "Changed-files JSON must be an array or contain a 'files' property."
            }
        }
        catch {
            Write-QaLog `
                -Level "WARNING" `
                -Message "Changed-file information could not be included in the summary: $($_.Exception.Message)"
        }
    }

    $overallStatus = Get-QaOverallStatus `
        -Results $results.ToArray()

    $overallTitle = Get-QaOverallTitle `
        -Status $overallStatus

    $recommendation = Get-QaRecommendation `
        -Status $overallStatus

    $blockingResults = @(
        $results |
            Where-Object {
                $_.blocking -eq $true -or
                $_.status -in @(
                    "FAILED",
                    "ERROR"
                )
            }
    )

    $warningResults = @(
        $results |
            Where-Object {
                $_.status -eq "WARNING"
            }
    )

    $totalFindings = 0
    foreach ($result in $results) {
        if ($null -ne $result.findingCount) {
            $totalFindings += [int]$result.findingCount
        }
    }

    $blockingFindingCount = 0
    foreach ($result in $blockingResults) {
        if ($null -ne $result.findingCount) {
            $blockingFindingCount += [int]$result.findingCount
        }
    }

    $advisoryFindingCount = 0
    foreach ($result in $warningResults) {
        if ($null -ne $result.findingCount) {
            $advisoryFindingCount += [int]$result.findingCount
        }
    }

    $generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

    $summaryLines = New-Object `
        System.Collections.Generic.List[string]

    $summaryLines.Add("# Backend PR Quality")
    $summaryLines.Add("")
    $summaryLines.Add("## Overall result")
    $summaryLines.Add("")
    $summaryLines.Add(
        "**$(Get-QaStatusSymbol -Status $overallStatus) $overallTitle**"
    )
    $summaryLines.Add("")
    $summaryLines.Add($recommendation)
    $summaryLines.Add("")
    $summaryLines.Add("| Metric | Result |")
    $summaryLines.Add("|---|---:|")
    $summaryLines.Add("| Files changed in PR | $($changedFiles.Count) |")
    $summaryLines.Add("| Blocking analyzer results | $($blockingResults.Count) |")
    $summaryLines.Add("| Blocking findings | $blockingFindingCount |")
    $summaryLines.Add("| Advisory findings | $advisoryFindingCount |")
    $summaryLines.Add("| Total analyzer findings | $totalFindings |")
    $summaryLines.Add("")
    $summaryLines.Add("## Analyzer status")
    $summaryLines.Add("")
    $summaryLines.Add("| Check | Status | Findings | Summary |")
    $summaryLines.Add("|---|---|---:|---|")

    $sortedResults = @(
        $results |
            Sort-Object `
                -Property @{
                    Expression = {
                        switch ([string]$_.category) {
                            "SECURITY" {
                                1
                            }

                            "CIRCULAR_DEPENDENCIES" {
                                2
                            }

                            "UNUSED_CODE" {
                                3
                            }

                            default {
                                99
                            }
                        }
                    }
                }
    )

    foreach ($result in $sortedResults) {
        $categoryName = Get-QaCategoryDisplayName `
            -Category ([string]$result.category)

        $statusLabel = Get-QaStatusLabel `
            -Status ([string]$result.status)

        $statusSymbol = Get-QaStatusSymbol `
            -Status ([string]$result.status)

        $safeSummary = Convert-ToQaSafeTableText `
            -Value ([string]$result.summary)

        $summaryLines.Add(
            "| $categoryName | $statusSymbol $statusLabel | $($result.findingCount) | $safeSummary |"
        )
    }

    $displayOrder = @(
        "ERROR",
        "FAILED",
        "WARNING",
        "PASSED",
        "SKIPPED"
    )

    foreach ($status in $displayOrder) {
        $statusResults = @(
            $sortedResults |
                Where-Object {
                    $_.status -eq $status
                }
        )

        foreach ($result in $statusResults) {
            $categoryName = Get-QaCategoryDisplayName `
                -Category ([string]$result.category)

            $summaryLines.Add("")
            $summaryLines.Add(
                "## $(Get-QaStatusSymbol -Status ([string]$result.status)) $categoryName"
            )
            $summaryLines.Add("")
            $summaryLines.Add(
                "**Status:** $(Get-QaStatusLabel -Status ([string]$result.status))"
            )
            $summaryLines.Add("")
            $summaryLines.Add([string]$result.summary)

            Add-QaResultDetails `
                -Lines $summaryLines `
                -Result $result `
                -MaximumFindings $MaximumDisplayedFindingsPerTool
        }
    }

    $summaryLines.Add("")
    $summaryLines.Add("## What the developer should do")
    $summaryLines.Add("")

    switch ($overallStatus) {
        "PASSED" {
            $summaryLines.Add(
                "No blocking advisory issues were detected in the files changed by this PR."
            )
            $summaryLines.Add("")
            $summaryLines.Add(
                "Continue with normal code review and functional verification."
            )
        }

        "WARNING" {
            $summaryLines.Add(
                "Review each advisory finding and confirm whether it is valid."
            )
            $summaryLines.Add("")
            $summaryLines.Add(
                "Fix valid findings or explain false positives in the Pull Request."
            )
        }

        "FAILED" {
            $summaryLines.Add(
                "Fix every blocking finding before merging."
            )
            $summaryLines.Add("")
            $summaryLines.Add(
                "After pushing the fixes, GitHub will rerun the PR checks automatically."
            )
        }

        "ERROR" {
            $summaryLines.Add(
                "The analysis did not complete reliably."
            )
            $summaryLines.Add("")
            $summaryLines.Add(
                "Review the failed analyzer logs or rerun the workflow after correcting the tooling issue."
            )
        }

        "SKIPPED" {
            $summaryLines.Add(
                "No relevant files were changed for the configured PR analyzers."
            )
        }
    }

    if ($overallStatus -in @("WARNING", "FAILED")) {
        $summaryLines.Add("")
        $summaryLines.Add("### Suggested PR response")
        $summaryLines.Add("")
        $summaryLines.Add('```text')
        $summaryLines.Add("Finding:")
        $summaryLines.Add(
            "Status: Fixed | False Positive | Deferred | Needs Review"
        )
        $summaryLines.Add("Explanation:")
        $summaryLines.Add("Evidence:")
        $summaryLines.Add("Follow-up issue or PR:")
        $summaryLines.Add('```')
    }

    $summaryLines.Add("")
    $summaryLines.Add("---")
    $summaryLines.Add("")
    $summaryLines.Add(
        "_Generated at $generatedAt by Gr8Books Neo PR Quality Automation._"
    )

    $summaryDirectory = Split-Path `
        -Path $resolvedSummaryPath `
        -Parent

    Ensure-QaDirectory `
        -Path $summaryDirectory |
        Out-Null

    [System.IO.File]::WriteAllLines(
        $resolvedSummaryPath,
        [string[]]$summaryLines,
        [System.Text.UTF8Encoding]::new($false)
    )

    $githubSummaryLines = @(
        foreach ($summaryLine in $summaryLines) {
            if ([string]::IsNullOrEmpty($summaryLine)) {
                "__QA_BLANK_LINE__"
            }
            else {
                [string]$summaryLine
            }
        }
    )

    Add-QaGitHubSummary `
        -Lines ([string[]]$githubSummaryLines)

    Write-QaGitHubOutput `
        -Name "overall_status" `
        -Value $overallStatus

    Write-QaGitHubOutput `
        -Name "blocking_result_count" `
        -Value ([string]$blockingResults.Count)

    Write-QaGitHubOutput `
        -Name "blocking_finding_count" `
        -Value ([string]$blockingFindingCount)

    Write-QaGitHubOutput `
        -Name "advisory_finding_count" `
        -Value ([string]$advisoryFindingCount)

    Write-QaGitHubOutput `
        -Name "summary_path" `
        -Value $resolvedSummaryPath

    Write-QaLog `
        -Level "SUCCESS" `
        -Message "PR quality summary generated: $resolvedSummaryPath"

    if ($overallStatus -in @("FAILED", "ERROR")) {
        exit 1
    }

    exit 0
}
catch {
    $errorMessage = $_.Exception.Message

    Write-QaLog `
        -Level "ERROR" `
        -Message "Summary generation failed: $errorMessage"

    $fallbackLines = @(
        "# Backend PR Quality",
        "",
        "## Overall result",
        "",
        "**[ERROR] QA TOOLING ERROR**",
        "",
        "The developer summary could not be generated reliably.",
        "",
        "### Error",
        "",
        '```text',
        $errorMessage,
        '```',
        "",
        "Do not rely on this advisory result until the automation error is corrected."
    )

    if (-not [string]::IsNullOrWhiteSpace($resolvedSummaryPath)) {
        try {
            $summaryDirectory = Split-Path `
                -Path $resolvedSummaryPath `
                -Parent

            Ensure-QaDirectory `
                -Path $summaryDirectory |
                Out-Null

            [System.IO.File]::WriteAllLines(
                $resolvedSummaryPath,
                [string[]]$fallbackLines,
                [System.Text.UTF8Encoding]::new($false)
            )
        }
        catch {
            Write-QaLog `
                -Level "ERROR" `
                -Message "Unable to write fallback summary: $($_.Exception.Message)"
        }
    }

    $githubFallbackLines = @(
        foreach ($fallbackLine in $fallbackLines) {
            if ([string]::IsNullOrEmpty($fallbackLine)) {
                "__QA_BLANK_LINE__"
            }
            else {
                [string]$fallbackLine
            }
        }
    )

    Add-QaGitHubSummary `
        -Lines ([string[]]$githubFallbackLines)

    Write-QaGitHubOutput `
        -Name "overall_status" `
        -Value "ERROR"

    Write-QaGitHubOutput `
        -Name "blocking_result_count" `
        -Value "1"

    Write-QaGitHubOutput `
        -Name "blocking_finding_count" `
        -Value "0"

    Write-QaGitHubOutput `
        -Name "advisory_finding_count" `
        -Value "0"

    exit 2
}
