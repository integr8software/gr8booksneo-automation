[CmdletBinding()]
param(
    [Parameter()]
    [string]$InputPath,

    [Parameter()]
    [string]$OutputDirectory,

    [Parameter()]
    [string]$MarkdownFileName = "Frontend-QA-Report.md",

    [Parameter()]
    [string]$HtmlFileName = "Frontend-QA-Report.html",

    [Parameter()]
    [int]$MaximumFindings = 50,

    [Parameter()]
    [string]$BuildResultPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$AutomationRoot = Resolve-Path (
    Join-Path $ScriptDirectory "..\.."
)

if ([string]::IsNullOrWhiteSpace($InputPath)) {
    $InputPath = Join-Path `
        $AutomationRoot `
        "reports\frontend-quality-results.json"
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path `
        $AutomationRoot `
        "reports"
}

if (-not [System.IO.Path]::IsPathRooted($InputPath)) {
    $InputPath = Join-Path $AutomationRoot $InputPath
}

if (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory = Join-Path `
        $AutomationRoot `
        $OutputDirectory
}

$InputPath = [System.IO.Path]::GetFullPath($InputPath)
$OutputDirectory = [System.IO.Path]::GetFullPath(
    $OutputDirectory
)

$MarkdownPath = Join-Path `
    $OutputDirectory `
    $MarkdownFileName

$HtmlPath = Join-Path `
    $OutputDirectory `
    $HtmlFileName

if (-not [string]::IsNullOrWhiteSpace($BuildResultPath)) {
    if (-not [System.IO.Path]::IsPathRooted($BuildResultPath)) {
        $BuildResultPath = Join-Path $AutomationRoot $BuildResultPath
    }

    $BuildResultPath = [System.IO.Path]::GetFullPath($BuildResultPath)
}

function Get-PropertyValue {
    param(
        [Parameter(Mandatory)]
        [object]$Object,

        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter()]
        [object]$DefaultValue = $null
    )

    if ($null -eq $Object) {
        return $DefaultValue
    }

    $property = $Object.PSObject.Properties[$Name]

    if ($null -eq $property) {
        return $DefaultValue
    }

    if ($null -eq $property.Value) {
        return $DefaultValue
    }

    return $property.Value
}

function ConvertTo-HtmlEncoded {
    param(
        [Parameter()]
        [AllowNull()]
        [object]$Value
    )

    if ($null -eq $Value) {
        return ""
    }

    return [System.Net.WebUtility]::HtmlEncode(
        [string]$Value
    )
}

function ConvertTo-MarkdownText {
    param(
        [Parameter()]
        [AllowNull()]
        [object]$Value
    )

    if ($null -eq $Value) {
        return ""
    }

    return ([string]$Value) `
        -replace '\|', '\|' `
        -replace "`r?`n", " "
}

function Get-DisplayLocation {
    param(
        [Parameter(Mandatory)]
        [object]$Finding
    )

    $file = [string](
        Get-PropertyValue `
            -Object $Finding `
            -Name "file" `
            -DefaultValue ""
    )

    $line = Get-PropertyValue `
        -Object $Finding `
        -Name "line" `
        -DefaultValue $null

    if (
        -not [string]::IsNullOrWhiteSpace($file) -and
        $null -ne $line
    ) {
        return "${file}:${line}"
    }

    if (-not [string]::IsNullOrWhiteSpace($file)) {
        return $file
    }

    return "General"
}

function Get-SeverityLabel {
    param(
        [Parameter()]
        [AllowNull()]
        [object]$Severity
    )

    switch ([string]$Severity) {
        "blocker" { return "Blocker" }
        "warning" { return "Warning" }
        "info"    { return "Info" }
        default   { return "Finding" }
    }
}

function Get-DecisionClass {
    param(
        [Parameter()]
        [AllowNull()]
        [object]$Status
    )

    switch ([string]$Status) {
        "blocked" { return "blocked" }
        "warning" { return "warning" }
        default   { return "passed" }
    }
}

function Get-DecisionDescription {
    param(
        [Parameter()]
        [AllowNull()]
        [object]$Status
    )

    switch ([string]$Status) {
        "blocked" {
            return "Blocking frontend quality findings must be resolved before the pull request proceeds."
        }

        "warning" {
            return "The pull request may proceed, but the listed warnings should be reviewed."
        }

        default {
            return "No blocking frontend quality findings were detected."
        }
    }
}

function Add-MarkdownFindingSection {
    param(
        [Parameter(Mandatory)]
        [System.Text.StringBuilder]$Builder,

        [Parameter(Mandatory)]
        [string]$Heading,

        [Parameter()]
        [AllowEmptyCollection()]
        [object[]]$Findings
    )

    [void]$Builder.AppendLine("## $Heading")
    [void]$Builder.AppendLine()

    if ($Findings.Count -eq 0) {
        [void]$Builder.AppendLine("No $($Heading.ToLowerInvariant()).")
        [void]$Builder.AppendLine()
        return
    }

    foreach ($finding in $Findings) {
        $category = ConvertTo-MarkdownText (
            Get-PropertyValue `
                -Object $finding `
                -Name "category" `
                -DefaultValue "general"
        )

        $title = ConvertTo-MarkdownText (
            Get-PropertyValue `
                -Object $finding `
                -Name "title" `
                -DefaultValue "Frontend quality finding"
        )

        $message = ConvertTo-MarkdownText (
            Get-PropertyValue `
                -Object $finding `
                -Name "message" `
                -DefaultValue ""
        )

        $recommendation = ConvertTo-MarkdownText (
            Get-PropertyValue `
                -Object $finding `
                -Name "recommendation" `
                -DefaultValue ""
        )

        $ruleId = ConvertTo-MarkdownText (
            Get-PropertyValue `
                -Object $finding `
                -Name "ruleId" `
                -DefaultValue ""
        )

        $location = ConvertTo-MarkdownText (
            Get-DisplayLocation -Finding $finding
        )

        [void]$Builder.AppendLine("### $title")
        [void]$Builder.AppendLine()
        [void]$Builder.AppendLine("- **Category:** $category")
        [void]$Builder.AppendLine("- **Rule:** ``$ruleId``")
        [void]$Builder.AppendLine("- **Location:** ``$location``")

        if (-not [string]::IsNullOrWhiteSpace($message)) {
            [void]$Builder.AppendLine("- **Issue:** $message")
        }

        if (
            -not [string]::IsNullOrWhiteSpace(
                $recommendation
            )
        ) {
            [void]$Builder.AppendLine(
                "- **Recommendation:** $recommendation"
            )
        }

        [void]$Builder.AppendLine()
    }
}

function Add-HtmlFindingCards {
    param(
        [Parameter(Mandatory)]
        [System.Text.StringBuilder]$Builder,

        [Parameter()]
        [AllowEmptyCollection()]
        [object[]]$Findings
    )

    if ($Findings.Count -eq 0) {
        [void]$Builder.AppendLine(@"
<div class="empty-state">
    No findings in this section.
</div>
"@)
        return
    }

    foreach ($finding in $Findings) {
        $severity = [string](
            Get-PropertyValue `
                -Object $finding `
                -Name "severity" `
                -DefaultValue "warning"
        )

        $severityLabel = ConvertTo-HtmlEncoded (
            Get-SeverityLabel -Severity $severity
        )

        $category = ConvertTo-HtmlEncoded (
            Get-PropertyValue `
                -Object $finding `
                -Name "category" `
                -DefaultValue "general"
        )

        $title = ConvertTo-HtmlEncoded (
            Get-PropertyValue `
                -Object $finding `
                -Name "title" `
                -DefaultValue "Frontend quality finding"
        )

        $message = ConvertTo-HtmlEncoded (
            Get-PropertyValue `
                -Object $finding `
                -Name "message" `
                -DefaultValue ""
        )

        $recommendation = ConvertTo-HtmlEncoded (
            Get-PropertyValue `
                -Object $finding `
                -Name "recommendation" `
                -DefaultValue ""
        )

        $ruleId = ConvertTo-HtmlEncoded (
            Get-PropertyValue `
                -Object $finding `
                -Name "ruleId" `
                -DefaultValue ""
        )

        $location = ConvertTo-HtmlEncoded (
            Get-DisplayLocation -Finding $finding
        )

        $codeSnippet = ConvertTo-HtmlEncoded (
            Get-PropertyValue `
                -Object $finding `
                -Name "codeSnippet" `
                -DefaultValue ""
        )

        $recommendationMarkup = ""

        if (
            -not [string]::IsNullOrWhiteSpace(
                $recommendation
            )
        ) {
            $recommendationMarkup = @"
<div class="recommendation">
    <strong>Recommendation</strong>
    <p>$recommendation</p>
</div>
"@
        }

        $codeMarkup = ""

        if (-not [string]::IsNullOrWhiteSpace($codeSnippet)) {
            $codeMarkup = @"
<pre><code>$codeSnippet</code></pre>
"@
        }

        [void]$Builder.AppendLine(@"
<article class="finding-card $severity">
    <div class="finding-heading">
        <div>
            <span class="severity-badge $severity">$severityLabel</span>
            <span class="category-badge">$category</span>
        </div>
        <code class="rule-id">$ruleId</code>
    </div>

    <h3>$title</h3>
    <p class="location">$location</p>
    <p class="finding-message">$message</p>

    $codeMarkup
    $recommendationMarkup
</article>
"@)
    }
}

if (-not (Test-Path -LiteralPath $InputPath)) {
    throw "Frontend quality result file was not found: $InputPath"
}

try {
    $report = Get-Content `
        -LiteralPath $InputPath `
        -Raw `
        -Encoding UTF8 |
        ConvertFrom-Json
}
catch {
    throw "Unable to read frontend quality result JSON: $($_.Exception.Message)"
}

New-Item `
    -ItemType Directory `
    -Path $OutputDirectory `
    -Force |
    Out-Null

$repository = Get-PropertyValue `
    -Object $report `
    -Name "repository" `
    -DefaultValue ([pscustomobject]@{})

$analysis = Get-PropertyValue `
    -Object $report `
    -Name "analysis" `
    -DefaultValue ([pscustomobject]@{})

$summary = Get-PropertyValue `
    -Object $report `
    -Name "summary" `
    -DefaultValue ([pscustomobject]@{})

$decision = Get-PropertyValue `
    -Object $report `
    -Name "decision" `
    -DefaultValue ([pscustomobject]@{})

$repositoryName = [string](
    Get-PropertyValue `
        -Object $repository `
        -Name "name" `
        -DefaultValue "Unknown repository"
)

$branch = [string](
    Get-PropertyValue `
        -Object $repository `
        -Name "branch" `
        -DefaultValue "Unknown branch"
)

$commitShort = [string](
    Get-PropertyValue `
        -Object $repository `
        -Name "commitShort" `
        -DefaultValue ""
)

$changedFileCount = [int](
    Get-PropertyValue `
        -Object $analysis `
        -Name "changedFileCount" `
        -DefaultValue 0
)

$total = [int](
    Get-PropertyValue `
        -Object $summary `
        -Name "total" `
        -DefaultValue 0
)

$blockers = [int](
    Get-PropertyValue `
        -Object $summary `
        -Name "blockers" `
        -DefaultValue 0
)

$warnings = [int](
    Get-PropertyValue `
        -Object $summary `
        -Name "warnings" `
        -DefaultValue 0
)

$info = [int](
    Get-PropertyValue `
        -Object $summary `
        -Name "info" `
        -DefaultValue 0
)

$status = [string](
    Get-PropertyValue `
        -Object $summary `
        -Name "status" `
        -DefaultValue (
            Get-PropertyValue `
                -Object $decision `
                -Name "status" `
                -DefaultValue "passed"
        )
)

$decisionLabel = [string](
    Get-PropertyValue `
        -Object $summary `
        -Name "label" `
        -DefaultValue (
            Get-PropertyValue `
                -Object $decision `
                -Name "label" `
                -DefaultValue "Ready To Proceed"
        )
)

$generatedAtRaw = [string](
    Get-PropertyValue `
        -Object $report `
        -Name "generatedAt" `
        -DefaultValue (
            [DateTimeOffset]::Now.ToString("o")
        )
)

try {
    $generatedAt = [DateTimeOffset]::Parse(
        $generatedAtRaw
    ).ToLocalTime()
}
catch {
    $generatedAt = [DateTimeOffset]::Now
}

$allFindings = @(
    Get-PropertyValue `
        -Object $report `
        -Name "findings" `
        -DefaultValue @()
)

$buildResult = $null
$buildFinding = $null
$buildRun = $null

if (
    -not [string]::IsNullOrWhiteSpace($BuildResultPath) -and
    (Test-Path -LiteralPath $BuildResultPath -PathType Leaf)
) {
    try {
        $buildResult = Get-Content `
            -LiteralPath $BuildResultPath `
            -Raw `
            -Encoding UTF8 |
            ConvertFrom-Json
    }
    catch {
        throw "Unable to read frontend build result JSON: $($_.Exception.Message)"
    }

    $buildStatus = [string](
        Get-PropertyValue `
            -Object $buildResult `
            -Name "status" `
            -DefaultValue "failed"
    )

    $buildDurationMs = [int](
        Get-PropertyValue `
            -Object $buildResult `
            -Name "durationMs" `
            -DefaultValue 0
    )

    $buildRun = [pscustomobject]@{
        detector = "Production Build"
        status = if ($buildStatus -eq "passed") { "completed" } else { "failed" }
        findings = if ($buildStatus -eq "passed") { 0 } else { 1 }
        durationMs = $buildDurationMs
    }

    if ($buildStatus -ne "passed") {
        $buildPhase = [string](
            Get-PropertyValue `
                -Object $buildResult `
                -Name "phase" `
                -DefaultValue "build"
        )

        $buildErrors = @(
            Get-PropertyValue `
                -Object $buildResult `
                -Name "errors" `
                -DefaultValue @()
        )

        $buildMessage = if ($buildPhase -eq "install") {
            "Frontend dependency installation failed before the production build could run."
        }
        else {
            "The frontend could not complete npm run build."
        }

        $buildSnippet = if ($buildErrors.Count -gt 0) {
            ($buildErrors | Select-Object -First 10) -join "`n"
        }
        else {
            "See the Build frontend repository step for the complete error output."
        }

        $buildFinding = [pscustomobject]@{
            category = "build"
            ruleId = "build.productionBuild"
            severity = "blocker"
            title = "Production build failed"
            message = $buildMessage
            recommendation = "Fix the reported build errors and push again. The PR will be retested automatically."
            file = "npm run build"
            line = $null
            column = $null
            codeSnippet = $buildSnippet
            relatedFiles = @()
            evidence = $buildErrors
            detector = "build"
            confidence = "high"
        }

        $allFindings = @($allFindings) + @($buildFinding)
        $total += 1
        $blockers += 1
        $status = "blocked"
        $decisionLabel = "QA Review Required"
    }
}

$displayFindings = @(
    $allFindings |
        Select-Object -First $MaximumFindings
)

$blockerFindings = @(
    $displayFindings |
        Where-Object {
            [string]$_.severity -eq "blocker"
        }
)

$warningFindings = @(
    $displayFindings |
        Where-Object {
            [string]$_.severity -eq "warning"
        }
)

$infoFindings = @(
    $displayFindings |
        Where-Object {
            [string]$_.severity -eq "info"
        }
)

$categorySummary = Get-PropertyValue `
    -Object $summary `
    -Name "categories" `
    -DefaultValue ([pscustomobject]@{})

$detectorRuns = @(
    Get-PropertyValue `
        -Object $analysis `
        -Name "detectorRuns" `
        -DefaultValue @()
)

if ($null -ne $buildRun) {
    $detectorRuns = @($detectorRuns) + @($buildRun)
}

# Markdown report

$markdown = [System.Text.StringBuilder]::new()

[void]$markdown.AppendLine("# Frontend PR Quality Report")
[void]$markdown.AppendLine()
[void]$markdown.AppendLine(
    "**Decision:** $decisionLabel"
)
[void]$markdown.AppendLine()
[void]$markdown.AppendLine(
    (Get-DecisionDescription -Status $status)
)
[void]$markdown.AppendLine()
[void]$markdown.AppendLine("## Pull Request")
[void]$markdown.AppendLine()
[void]$markdown.AppendLine("| Property | Value |")
[void]$markdown.AppendLine("|---|---|")
[void]$markdown.AppendLine(
    "| Repository | $(ConvertTo-MarkdownText $repositoryName) |"
)
[void]$markdown.AppendLine(
    "| Branch | $(ConvertTo-MarkdownText $branch) |"
)

if (-not [string]::IsNullOrWhiteSpace($commitShort)) {
    [void]$markdown.AppendLine(
        "| Commit | ``$(ConvertTo-MarkdownText $commitShort)`` |"
    )
}

[void]$markdown.AppendLine(
    "| Generated | $($generatedAt.ToString("yyyy-MM-dd HH:mm:ss zzz")) |"
)
[void]$markdown.AppendLine()
[void]$markdown.AppendLine("## Summary")
[void]$markdown.AppendLine()
[void]$markdown.AppendLine("| Metric | Count |")
[void]$markdown.AppendLine("|---|---:|")
[void]$markdown.AppendLine(
    "| Changed files | $changedFileCount |"
)
[void]$markdown.AppendLine(
    "| Total findings | $total |"
)
[void]$markdown.AppendLine(
    "| Blockers | $blockers |"
)
[void]$markdown.AppendLine(
    "| Warnings | $warnings |"
)
[void]$markdown.AppendLine(
    "| Information | $info |"
)
[void]$markdown.AppendLine()
[void]$markdown.AppendLine("## Quality Checks")
[void]$markdown.AppendLine()
[void]$markdown.AppendLine(
    "| Detector | Status | Findings | Duration |"
)
[void]$markdown.AppendLine(
    "|---|---|---:|---:|"
)

foreach ($run in $detectorRuns) {
    $detectorName = ConvertTo-MarkdownText (
        Get-PropertyValue `
            -Object $run `
            -Name "detector" `
            -DefaultValue "unknown"
    )

    $runStatus = ConvertTo-MarkdownText (
        Get-PropertyValue `
            -Object $run `
            -Name "status" `
            -DefaultValue "unknown"
    )

    $runFindings = [int](
        Get-PropertyValue `
            -Object $run `
            -Name "findings" `
            -DefaultValue 0
    )

    $durationMs = [int](
        Get-PropertyValue `
            -Object $run `
            -Name "durationMs" `
            -DefaultValue 0
    )

    [void]$markdown.AppendLine(
        "| $detectorName | $runStatus | $runFindings | ${durationMs} ms |"
    )
}

[void]$markdown.AppendLine()

Add-MarkdownFindingSection `
    -Builder $markdown `
    -Heading "Blockers" `
    -Findings $blockerFindings

Add-MarkdownFindingSection `
    -Builder $markdown `
    -Heading "Warnings" `
    -Findings $warningFindings

Add-MarkdownFindingSection `
    -Builder $markdown `
    -Heading "Information" `
    -Findings $infoFindings

if ($allFindings.Count -gt $displayFindings.Count) {
    [void]$markdown.AppendLine(
        "> Showing $($displayFindings.Count) of $($allFindings.Count) findings."
    )
    [void]$markdown.AppendLine()
}

[void]$markdown.AppendLine("---")
[void]$markdown.AppendLine()
[void]$markdown.AppendLine(
    "Generated by Gr8BooksNeo Frontend PR Quality Automation."
)

[System.IO.File]::WriteAllText(
    $MarkdownPath,
    $markdown.ToString(),
    [System.Text.UTF8Encoding]::new($false)
)

# HTML detector rows

$detectorRows = [System.Text.StringBuilder]::new()

foreach ($run in $detectorRuns) {
    $detectorName = ConvertTo-HtmlEncoded (
        Get-PropertyValue `
            -Object $run `
            -Name "detector" `
            -DefaultValue "unknown"
    )

    $runStatus = [string](
        Get-PropertyValue `
            -Object $run `
            -Name "status" `
            -DefaultValue "unknown"
    )

    $runFindings = [int](
        Get-PropertyValue `
            -Object $run `
            -Name "findings" `
            -DefaultValue 0
    )

    $durationMs = [int](
        Get-PropertyValue `
            -Object $run `
            -Name "durationMs" `
            -DefaultValue 0
    )

    $statusClass = if ($runStatus -eq "completed") {
        "completed"
    }
    else {
        "failed"
    }

    [void]$detectorRows.AppendLine(@"
<tr>
    <td class="detector-name">$detectorName</td>
    <td>
        <span class="run-status $statusClass">
            $(ConvertTo-HtmlEncoded $runStatus)
        </span>
    </td>
    <td>$runFindings</td>
    <td>${durationMs} ms</td>
</tr>
"@)
}

$blockerCards = [System.Text.StringBuilder]::new()
$warningCards = [System.Text.StringBuilder]::new()
$infoCards = [System.Text.StringBuilder]::new()

Add-HtmlFindingCards `
    -Builder $blockerCards `
    -Findings $blockerFindings

Add-HtmlFindingCards `
    -Builder $warningCards `
    -Findings $warningFindings

Add-HtmlFindingCards `
    -Builder $infoCards `
    -Findings $infoFindings

$decisionClass = Get-DecisionClass -Status $status

$encodedRepositoryName = ConvertTo-HtmlEncoded $repositoryName
$encodedBranch = ConvertTo-HtmlEncoded $branch
$encodedCommit = ConvertTo-HtmlEncoded $commitShort
$encodedDecisionLabel = ConvertTo-HtmlEncoded $decisionLabel
$encodedDecisionDescription = ConvertTo-HtmlEncoded (
    Get-DecisionDescription -Status $status
)

$commitMarkup = ""

if (-not [string]::IsNullOrWhiteSpace($commitShort)) {
    $commitMarkup = @"
<span class="metadata-separator">/</span>
<span>Commit <code>$encodedCommit</code></span>
"@
}

$truncatedMessage = ""

if ($allFindings.Count -gt $displayFindings.Count) {
    $truncatedMessage = @"
<p class="truncated-message">
    Showing $($displayFindings.Count) of $($allFindings.Count) findings.
</p>
"@
}

$html = @"
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta
        name="viewport"
        content="width=device-width, initial-scale=1"
    >
    <title>Frontend PR Quality Report</title>

    <style>
        :root {
            color-scheme: light;
            --page: #f4f6f8;
            --surface: #ffffff;
            --surface-muted: #f8fafc;
            --border: #dfe4ea;
            --text: #182230;
            --text-muted: #667085;
            --passed: #177245;
            --passed-background: #e8f7ef;
            --warning: #946200;
            --warning-background: #fff6dd;
            --blocked: #b42318;
            --blocked-background: #fff0ee;
            --info: #175cd3;
            --info-background: #eff8ff;
            --shadow: 0 10px 30px rgba(16, 24, 40, 0.08);
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            background: var(--page);
            color: var(--text);
            font-family:
                Inter,
                "Segoe UI",
                Arial,
                sans-serif;
            line-height: 1.5;
        }

        .page {
            width: min(1180px, calc(100% - 40px));
            margin: 36px auto;
        }

        .header,
        .panel,
        .decision-panel {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 16px;
            box-shadow: var(--shadow);
        }

        .header {
            padding: 28px 30px;
        }

        .eyebrow {
            margin: 0 0 8px;
            color: var(--info);
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }

        h1,
        h2,
        h3,
        p {
            margin-top: 0;
        }

        h1 {
            margin-bottom: 8px;
            font-size: 30px;
            line-height: 1.2;
        }

        .subtitle {
            margin-bottom: 18px;
            color: var(--text-muted);
        }

        .metadata {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            color: var(--text-muted);
            font-size: 14px;
        }

        .metadata-separator {
            color: #c0c7d0;
        }

        code {
            font-family:
                "Cascadia Code",
                Consolas,
                monospace;
        }

        .decision-panel {
            margin-top: 20px;
            padding: 24px 28px;
            border-left-width: 6px;
        }

        .decision-panel.passed {
            border-left-color: var(--passed);
            background: var(--passed-background);
        }

        .decision-panel.warning {
            border-left-color: var(--warning);
            background: var(--warning-background);
        }

        .decision-panel.blocked {
            border-left-color: var(--blocked);
            background: var(--blocked-background);
        }

        .decision-label {
            margin-bottom: 4px;
            font-size: 24px;
            font-weight: 750;
        }

        .decision-panel p {
            margin-bottom: 0;
            color: var(--text-muted);
        }

        .metrics {
            display: grid;
            grid-template-columns:
                repeat(5, minmax(0, 1fr));
            gap: 14px;
            margin-top: 20px;
        }

        .metric {
            padding: 20px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 14px;
            box-shadow: var(--shadow);
        }

        .metric-label {
            display: block;
            margin-bottom: 6px;
            color: var(--text-muted);
            font-size: 13px;
            font-weight: 650;
        }

        .metric-value {
            font-size: 30px;
            font-weight: 750;
        }

        .panel {
            margin-top: 20px;
            padding: 26px 28px;
        }

        .section-heading {
            margin-bottom: 18px;
        }

        .section-heading h2 {
            margin-bottom: 4px;
            font-size: 21px;
        }

        .section-heading p {
            margin-bottom: 0;
            color: var(--text-muted);
            font-size: 14px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
        }

        th,
        td {
            padding: 13px 12px;
            border-bottom: 1px solid var(--border);
            text-align: left;
        }

        th {
            color: var(--text-muted);
            font-size: 12px;
            letter-spacing: 0.04em;
            text-transform: uppercase;
        }

        td {
            font-size: 14px;
        }

        .detector-name {
            font-weight: 650;
            text-transform: capitalize;
        }

        .run-status,
        .severity-badge,
        .category-badge {
            display: inline-flex;
            align-items: center;
            border-radius: 999px;
            padding: 4px 9px;
            font-size: 12px;
            font-weight: 700;
        }

        .run-status.completed {
            color: var(--passed);
            background: var(--passed-background);
        }

        .run-status.failed {
            color: var(--blocked);
            background: var(--blocked-background);
        }

        .findings-grid {
            display: grid;
            gap: 14px;
        }

        .finding-card {
            padding: 20px;
            border: 1px solid var(--border);
            border-left-width: 5px;
            border-radius: 12px;
            background: var(--surface-muted);
        }

        .finding-card.blocker {
            border-left-color: var(--blocked);
        }

        .finding-card.warning {
            border-left-color: var(--warning);
        }

        .finding-card.info {
            border-left-color: var(--info);
        }

        .finding-heading {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            align-items: center;
            margin-bottom: 13px;
        }

        .severity-badge.blocker {
            color: var(--blocked);
            background: var(--blocked-background);
        }

        .severity-badge.warning {
            color: var(--warning);
            background: var(--warning-background);
        }

        .severity-badge.info {
            color: var(--info);
            background: var(--info-background);
        }

        .category-badge {
            margin-left: 6px;
            color: #344054;
            background: #e9edf2;
            text-transform: capitalize;
        }

        .rule-id {
            color: var(--text-muted);
            font-size: 12px;
        }

        .finding-card h3 {
            margin-bottom: 5px;
            font-size: 18px;
        }

        .location {
            margin-bottom: 12px;
            color: var(--info);
            font-family:
                "Cascadia Code",
                Consolas,
                monospace;
            font-size: 13px;
            overflow-wrap: anywhere;
        }

        .finding-message {
            color: #344054;
        }

        pre {
            overflow-x: auto;
            margin: 14px 0;
            padding: 13px;
            border: 1px solid var(--border);
            border-radius: 9px;
            background: #101828;
            color: #f9fafb;
        }

        .recommendation {
            margin-top: 14px;
            padding: 13px 15px;
            border-radius: 9px;
            background: #eef4ff;
        }

        .recommendation strong {
            display: block;
            margin-bottom: 3px;
        }

        .recommendation p {
            margin-bottom: 0;
            color: #344054;
        }

        .empty-state {
            padding: 24px;
            border: 1px dashed var(--border);
            border-radius: 10px;
            color: var(--text-muted);
            text-align: center;
        }

        .truncated-message {
            margin-top: 18px;
            color: var(--text-muted);
            font-size: 13px;
        }

        footer {
            padding: 22px 0 10px;
            color: var(--text-muted);
            font-size: 13px;
            text-align: center;
        }

        @media (max-width: 900px) {
            .metrics {
                grid-template-columns:
                    repeat(2, minmax(0, 1fr));
            }
        }

        @media (max-width: 620px) {
            .page {
                width: min(100% - 20px, 1180px);
                margin: 10px auto;
            }

            .header,
            .panel,
            .decision-panel {
                border-radius: 12px;
            }

            .metrics {
                grid-template-columns: 1fr;
            }

            .finding-heading {
                align-items: flex-start;
                flex-direction: column;
            }

            table {
                display: block;
                overflow-x: auto;
            }
        }

        @media print {
            body {
                background: #ffffff;
            }

            .page {
                width: 100%;
                margin: 0;
            }

            .header,
            .panel,
            .decision-panel,
            .metric {
                box-shadow: none;
                break-inside: avoid;
            }
        }
    </style>
</head>

<body>
    <main class="page">
        <header class="header">
            <p class="eyebrow">
                Gr8BooksNeo Quality Automation
            </p>

            <h1>Frontend PR Quality Report</h1>

            <p class="subtitle">
                Engineering consistency analysis for changed frontend files.
            </p>

            <div class="metadata">
                <span>$encodedRepositoryName</span>
                <span class="metadata-separator">/</span>
                <span>Branch <code>$encodedBranch</code></span>
                $commitMarkup
                <span class="metadata-separator">/</span>
                <span>
                    Generated
                    $($generatedAt.ToString("yyyy-MM-dd HH:mm:ss zzz"))
                </span>
            </div>
        </header>

        <section class="decision-panel $decisionClass">
            <div class="decision-label">
                $encodedDecisionLabel
            </div>
            <p>$encodedDecisionDescription</p>
        </section>

        <section class="metrics">
            <div class="metric">
                <span class="metric-label">Changed Files</span>
                <span class="metric-value">$changedFileCount</span>
            </div>

            <div class="metric">
                <span class="metric-label">Total Findings</span>
                <span class="metric-value">$total</span>
            </div>

            <div class="metric">
                <span class="metric-label">Blockers</span>
                <span class="metric-value">$blockers</span>
            </div>

            <div class="metric">
                <span class="metric-label">Warnings</span>
                <span class="metric-value">$warnings</span>
            </div>

            <div class="metric">
                <span class="metric-label">Information</span>
                <span class="metric-value">$info</span>
            </div>
        </section>

        <section class="panel">
            <div class="section-heading">
                <h2>Quality Checks</h2>
                <p>
                    Execution status and findings produced by each detector.
                </p>
            </div>

            <table>
                <thead>
                    <tr>
                        <th>Detector</th>
                        <th>Status</th>
                        <th>Findings</th>
                        <th>Duration</th>
                    </tr>
                </thead>

                <tbody>
                    $($detectorRows.ToString())
                </tbody>
            </table>
        </section>

        <section class="panel">
            <div class="section-heading">
                <h2>Blockers</h2>
                <p>
                    Findings that must be fixed before proceeding.
                </p>
            </div>

            <div class="findings-grid">
                $($blockerCards.ToString())
            </div>
        </section>

        <section class="panel">
            <div class="section-heading">
                <h2>Warnings</h2>
                <p>
                    Findings requiring review but not currently blocking.
                </p>
            </div>

            <div class="findings-grid">
                $($warningCards.ToString())
            </div>
        </section>

        <section class="panel">
            <div class="section-heading">
                <h2>Information</h2>
                <p>
                    Informational observations from the frontend analysis.
                </p>
            </div>

            <div class="findings-grid">
                $($infoCards.ToString())
            </div>

            $truncatedMessage
        </section>

        <footer>
            Generated by Gr8BooksNeo Frontend PR Quality Automation.
        </footer>
    </main>
</body>
</html>
"@

[System.IO.File]::WriteAllText(
    $HtmlPath,
    $html,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host ""
Write-Host "Frontend QA summary generated."
Write-Host "Input    : $InputPath"
Write-Host "Markdown : $MarkdownPath"
Write-Host "HTML     : $HtmlPath"
Write-Host "Decision : $decisionLabel"
Write-Host "Findings : $total"
Write-Host ""