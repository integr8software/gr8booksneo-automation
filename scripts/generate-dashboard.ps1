param(
    [string]$ToolkitRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$RepositoryRoot = "",
    [string]$ResultsDirectory = "",
    [string]$ChangedFilesPath = "",
    [string]$TemplatePath = "",
    [string]$OutputPath = "",
    [string]$BuildResultPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Convert-ToHtmlText([object]$Value) {
    if ($null -eq $Value) { return "" }
    return [System.Net.WebUtility]::HtmlEncode([string]$Value)
}

function Read-Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $raw = Get-Content -LiteralPath $Path -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return $raw | ConvertFrom-Json
}

function First-Text([string[]]$Values) {
    foreach ($value in $Values) {
        if (-not [string]::IsNullOrWhiteSpace($value)) { return $value.Trim() }
    }
    return ""
}

function Git-Text([string]$WorkingDirectory, [string[]]$Arguments) {
    try {
        $value = & git -C $WorkingDirectory @Arguments 2>$null
        if ($LASTEXITCODE -eq 0 -and $null -ne $value) {
            return ([string]($value | Select-Object -First 1)).Trim()
        }
    } catch {}
    return ""
}

function Get-ChangedCount([object]$Document) {
    if ($null -eq $Document) { return 0 }
    if ($Document -is [array]) { return @($Document).Count }

    foreach ($name in @("files", "changedFiles", "paths", "items")) {
        $property = $Document.PSObject.Properties[$name]
        if ($null -ne $property -and $null -ne $property.Value) {
            return @($property.Value).Count
        }
    }

    return 0
}

function Category-Info([string]$Category) {
    switch ($Category) {
        "SECURITY" {
            return @{
                Name = "Security Check"; Tool = "Semgrep"; Bubble = "";
                Icon = '<svg viewBox="0 0 24 24" fill="none" stroke="#1261d8" stroke-width="2"><path d="M12 3 19 6v5c0 5-3 8.5-7 11-4-2.5-7-6-7-11V6l7-3Z"/></svg>';
                Symbol = "⬟"; Color = "#d91f33";
                Fix = "Review the affected code and apply the safer implementation recommended by the security rule."
            }
        }
        "CIRCULAR_DEPENDENCIES" {
            return @{
                Name = "Dependency Check"; Tool = "Madge"; Bubble = "purple";
                Icon = '<svg viewBox="0 0 24 24" fill="none" stroke="#6b36d8" stroke-width="2"><path d="M12 3a9 9 0 1 1-6.36 2.64" stroke-dasharray="4 2"/></svg>';
                Symbol = "◌"; Color = "#6938d8";
                Fix = "Move shared behavior into a separate module that both modules can use without depending on each other."
            }
        }
        "BACKEND_REQUIREMENTS" {
            return @{
                Name = "Backend Requirements"; Tool = "PR Swagger/Jest Check"; Bubble = "";
                Icon = '<svg viewBox="0 0 24 24" fill="none" stroke="#1261d8" stroke-width="2"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>';
                Symbol = "✓"; Color = "#1261d8";
                Fix = "Apply the requirement only to the changed behavior: document changed API contracts and add meaningful Jest coverage for business-critical logic. Do not add checklist-only tests."
            }
        }
        default {
            return @{
                Name = "Code Cleanup"; Tool = "Knip"; Bubble = "amber";
                Icon = '<svg viewBox="0 0 24 24" fill="none" stroke="#e49a00" stroke-width="2"><path d="m15 4 5 5-8 8-5-5 8-8Z"/><path d="m7 12-3 8 8-3"/></svg>';
                Symbol = "⌁"; Color = "#df9400";
                Fix = "Remove the code when it is no longer needed, or confirm that it remains part of the intended public API."
            }
        }
    }
}

function Badge-Info([string]$Status) {
    switch ($Status) {
        "PASSED"  { return @{ Class = ""; Text = "● PASS" } }
        "WARNING" { return @{ Class = "warning"; Text = "● REVIEW" } }
        "FAILED"  { return @{ Class = "failed"; Text = "● FIX" } }
        "ERROR"   { return @{ Class = "error"; Text = "● ERROR" } }
        default   { return @{ Class = "skipped"; Text = "● SKIPPED" } }
    }
}

function Overall-Status([object[]]$Results) {
    if (@($Results | Where-Object status -eq "ERROR").Count -gt 0) { return "ERROR" }
    if (@($Results | Where-Object { $_.status -eq "FAILED" -or $_.blocking -eq $true }).Count -gt 0) { return "FAILED" }
    if (@($Results | Where-Object status -eq "WARNING").Count -gt 0) { return "WARNING" }
    if (@($Results | Where-Object status -eq "PASSED").Count -gt 0) { return "PASSED" }
    return "SKIPPED"
}

function Overall-Info([string]$Status) {
    switch ($Status) {
        "PASSED" {
            return @{
                Theme="theme-pass"; Title="READY FOR REVIEW";
                Copy="No blocking issues were detected in this Pull Request.";
                RecommendationTitle="Everything looks good.";
                RecommendationText="Continue with normal code review.";
                Bottom="Continue with normal code review. Push updates normally and this report will refresh automatically."
            }
        }
        "WARNING" {
            return @{
                Theme="theme-warning"; Title="REVIEW RECOMMENDED";
                Copy="No merge-blocking issues were found, but some improvements should be reviewed.";
                RecommendationTitle="A few improvements were found.";
                RecommendationText="Review the recommendations before merging.";
                Bottom="Review the recommended improvements, then merge when you are satisfied with the changes."
            }
        }
        "FAILED" {
            return @{
                Theme="theme-fail"; Title="CHANGES REQUIRED";
                Copy="Important issues must be fixed before this Pull Request can be merged.";
                RecommendationTitle="Please address the required fixes.";
                RecommendationText="Push the fixes and the checks will run again automatically.";
                Bottom="Fix the must-fix items before merging. Push updates normally and this report will refresh automatically."
            }
        }
        "ERROR" {
            return @{
                Theme="theme-error"; Title="QUALITY CHECK FAILED";
                Copy="One or more quality checks could not complete successfully.";
                RecommendationTitle="The report is incomplete.";
                RecommendationText="Correct the tooling error and run the checks again.";
                Bottom="Do not rely on this report until the quality-check error has been corrected."
            }
        }
        default {
            return @{
                Theme="theme-skipped"; Title="NO RELEVANT CHANGES";
                Copy="No files relevant to the configured checks were changed.";
                RecommendationTitle="No action is needed.";
                RecommendationText="Continue with the normal Pull Request process.";
                Bottom="No relevant backend source changes were found for the configured checks."
            }
        }
    }
}

$ToolkitRoot = [IO.Path]::GetFullPath($ToolkitRoot)
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = First-Text @($env:GITHUB_WORKSPACE, (Split-Path -Parent $ToolkitRoot))
}
if ([string]::IsNullOrWhiteSpace($ResultsDirectory)) {
    $ResultsDirectory = Join-Path $ToolkitRoot "reports\results"
}
if ([string]::IsNullOrWhiteSpace($ChangedFilesPath)) {
    $ChangedFilesPath = Join-Path $ToolkitRoot "reports\raw\changed-files.json"
}
if ([string]::IsNullOrWhiteSpace($TemplatePath)) {
    $TemplatePath = Join-Path $ToolkitRoot "templates\dashboard.html"
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $ToolkitRoot "reports\QA-Report.html"
}

if ([string]::IsNullOrWhiteSpace($BuildResultPath)) {
    $BuildResultPath = Join-Path $RepositoryRoot "reports\backend-build-result.json"
}
elseif (-not [IO.Path]::IsPathRooted($BuildResultPath)) {
    $BuildResultPath = Join-Path $RepositoryRoot $BuildResultPath
}

$BuildResultPath = [IO.Path]::GetFullPath($BuildResultPath)

if (-not (Test-Path -LiteralPath $TemplatePath -PathType Leaf)) {
    throw "Dashboard template not found: $TemplatePath"
}
if (-not (Test-Path -LiteralPath $ResultsDirectory -PathType Container)) {
    throw "Results directory not found: $ResultsDirectory"
}

$resultFiles = Get-ChildItem -LiteralPath $ResultsDirectory -Filter "*-result.json" -File | Sort-Object Name
$results = @()
foreach ($file in $resultFiles) {
    $item = Read-Json $file.FullName
    if ($null -ne $item) { $results += $item }
}
if ($results.Count -eq 0) {
    throw "No normalized result files were found in $ResultsDirectory"
}

$buildResult = Read-Json $BuildResultPath
$buildFailed = $false
$buildStatus = "SKIPPED"
$buildDurationMs = 0
$buildErrors = @()

if ($null -ne $buildResult) {
    $rawBuildStatus = if ($buildResult.PSObject.Properties["status"]) {
        [string]$buildResult.status
    } else {
        "failed"
    }

    $buildStatus = if ($rawBuildStatus -eq "passed") { "PASSED" } else { "FAILED" }
    $buildFailed = ($buildStatus -eq "FAILED")

    if ($buildResult.PSObject.Properties["durationMs"]) {
        $buildDurationMs = [int]$buildResult.durationMs
    }

    if ($buildResult.PSObject.Properties["errors"] -and $null -ne $buildResult.errors) {
        $buildErrors = @($buildResult.errors)
    }
}

$findings = @()
foreach ($result in $results) {
    $category = Category-Info ([string]$result.category)
    foreach ($detail in @($result.details)) {
        $severity = if ($detail.PSObject.Properties["severity"]) { [string]$detail.severity } else { "INFO" }
        $mustFix = ($result.blocking -eq $true -or $result.status -in @("FAILED","ERROR") -or $severity -in @("HIGH","CRITICAL"))
        $file = if ($detail.PSObject.Properties["file"]) { [string]$detail.file } else { "" }
        $line = if ($detail.PSObject.Properties["line"]) { $detail.line } else { $null }
        $rule = if ($detail.PSObject.Properties["ruleId"]) { [string]$detail.ruleId } else { "" }
        $message = if ($detail.PSObject.Properties["message"]) { [string]$detail.message } else { "Finding detected" }

        if (-not [string]::IsNullOrWhiteSpace($file) -and $null -ne $line) {
            $location = "$file, line $line"
        } elseif (-not [string]::IsNullOrWhiteSpace($file)) {
            $location = $file
        } elseif (-not [string]::IsNullOrWhiteSpace($rule)) {
            $location = $rule
        } else {
            $location = $category.Name
        }

        $findings += [pscustomobject]@{
            title=$message
            meta="$(if($mustFix){'Must fix before merge'}else{'Recommended improvement'}) · $($category.Name)"
            pill=$(if($mustFix){'Must Fix'}else{'Recommendation'})
            kind=$(if($mustFix){'must'}else{'rec'})
            location=$location
            problem=$message
            fix=$category.Fix
            symbol=$category.Symbol
            symbolColor=$category.Color
            isMustFix=$mustFix
        }
    }
}

if ($buildFailed) {
    $buildErrorText = if ($buildErrors.Count -gt 0) {
        ($buildErrors | Select-Object -First 10) -join " | "
    } else {
        "The backend production build returned a non-zero exit code."
    }

    $findings += [pscustomobject]@{
        title = "Production build failed"
        meta = "Must fix before merge · Production Build"
        pill = "Must Fix"
        kind = "must"
        location = "npm run build"
        problem = $buildErrorText
        fix = "Fix the reported backend build errors and push again. The PR will be retested automatically."
        symbol = "!"
        symbolColor = "#d91f33"
        isMustFix = $true
    }
}

$overallStatus = Overall-Status $results

if ($buildFailed) {
    $overallStatus = "FAILED"
}

$overall = Overall-Info $overallStatus
$changedCount = Get-ChangedCount (Read-Json $ChangedFilesPath)
$blockingCount = @($findings | Where-Object isMustFix).Count
$advisoryCount = @($findings | Where-Object { -not $_.isMustFix }).Count

$totalDuration = 0
foreach ($result in $results) { $totalDuration += [int]$result.durationMs }
$totalDuration += $buildDurationMs
$durationText = if ($totalDuration -lt 1000) { "$totalDuration ms" } else { "{0:N1}s" -f ($totalDuration / 1000) }

$repository = First-Text @($env:QA_REPOSITORY, $env:GITHUB_REPOSITORY, (Split-Path -Leaf $RepositoryRoot))
if ($repository.Contains("/")) { $repository = $repository.Split("/")[-1] }

$branch = First-Text @($env:QA_BRANCH, $env:GITHUB_HEAD_REF, (Git-Text $RepositoryRoot @("branch","--show-current")), "unknown")
$commit = First-Text @($env:QA_COMMIT_SHA, $env:GITHUB_SHA, (Git-Text $RepositoryRoot @("rev-parse","--short","HEAD")), "unknown")
if ($commit.Length -gt 8) { $commit = $commit.Substring(0,8) }

$triggeredBy = First-Text @($env:QA_PR_AUTHOR, $env:QA_TRIGGERED_BY, $env:GITHUB_ACTOR, (Git-Text $RepositoryRoot @("config","user.name")), "Local developer")
if (-not $triggeredBy.StartsWith("@")) { $triggeredBy = "@$triggeredBy" }

$qualityCards = @()
foreach ($categoryName in @("SECURITY","CIRCULAR_DEPENDENCIES","UNUSED_CODE","BACKEND_REQUIREMENTS")) {
    $category = Category-Info $categoryName
    $result = $results | Where-Object category -eq $categoryName | Select-Object -First 1
    $status = if ($null -eq $result) { "SKIPPED" } else { [string]$result.status }
    $count = if ($null -eq $result) { 0 } else { [int]$result.findingCount }
    $badge = Badge-Info $status
    $issueText = if ($count -eq 1) { "1 issue found" } else { "$count issues found" }

    $qualityCards += @"
<div class="check-card card"><div class="icon-bubble $($category.Bubble)">$($category.Icon)</div><div><div class="check-name">$(Convert-ToHtmlText $category.Name)</div><div class="powered">Powered by $(Convert-ToHtmlText $category.Tool)</div></div><div class="result"><span class="badge $($badge.Class)">$(Convert-ToHtmlText $badge.Text)</span><div class="count">$(Convert-ToHtmlText $issueText)</div></div></div>
"@
}


$buildBadge = Badge-Info $buildStatus
$buildIssueCount = if ($buildFailed) { 1 } else { 0 }
$buildIssueText = if ($buildFailed) { "1 blocking build issue" } elseif ($buildStatus -eq "PASSED") { "Production build passed" } else { "Build result unavailable" }

$qualityCards += @"
<div class="check-card card"><div class="icon-bubble"><svg viewBox="0 0 24 24" fill="none" stroke="#1261d8" stroke-width="2"><path d="M8 3h8l1 4h3v14H4V7h3l1-4Z"/><path d="M8 12h8M12 8v8"/></svg></div><div><div class="check-name">Production Build</div><div class="powered">Powered by npm run build</div></div><div class="result"><span class="badge $($buildBadge.Class)">$(Convert-ToHtmlText $buildBadge.Text)</span><div class="count">$(Convert-ToHtmlText $buildIssueText)</div></div></div>
"@

if ($findings.Count -eq 0) {
    $overviewIssues = '<div class="empty-issues">No issues need your attention.</div>'
    $findingCards = '<div class="empty-issues">No findings were reported.</div>'
    $viewAllButton = ""
} else {
    $overviewRows = @()
    for ($i=0; $i -lt [Math]::Min(3,$findings.Count); $i++) {
        $f = $findings[$i]
        $overviewRows += @"
<div class="issue" data-open="details" data-index="$i"><span style="color:$($f.symbolColor)">$(Convert-ToHtmlText $f.symbol)</span><div><div class="issue-title">$(Convert-ToHtmlText $f.title)</div><div class="issue-path">$(Convert-ToHtmlText $f.location)</div></div><span class="pill $($f.kind)">$(Convert-ToHtmlText $f.pill)</span><span>›</span></div>
"@
    }
    $overviewIssues = $overviewRows -join [Environment]::NewLine

    $cards = @()
    for ($i=0; $i -lt $findings.Count; $i++) {
        $f = $findings[$i]
        $cards += @"
<div class="finding-card" data-finding="$i"><h3>$(Convert-ToHtmlText $f.title)</h3><p>$(Convert-ToHtmlText $f.location) · $(Convert-ToHtmlText $f.pill)</p></div>
"@
    }
    $findingCards = $cards -join [Environment]::NewLine
    $viewAllButton = '<button class="mini-link" data-open="details">View all details →</button>'
}

$findingsJson = $findings | Select-Object title,meta,pill,kind,location,problem,fix | ConvertTo-Json -Depth 5 -Compress
if ($findings.Count -eq 0) { $findingsJson = "[]" }
elseif ($findings.Count -eq 1) { $findingsJson = "[$findingsJson]" }
$findingsJsonBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($findingsJson))

$template = Get-Content -LiteralPath $TemplatePath -Raw
$shieldIcon = '<svg viewBox="0 0 64 64"><path d="M32 5 52 13v15c0 14-8.5 24.5-20 31C20.5 52.5 12 42 12 28V13L32 5Z" fill="#18a34a"/><path d="m22 31 7 7 14-16" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
$recommendationIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 10v10H4V10h3Zm3 10h7.5a2 2 0 0 0 1.94-1.52l1.25-5A2 2 0 0 0 18.75 11H15l.5-3A3 3 0 0 0 12.54 4L9 10v10h1Z"/></svg>'

$values = @{
    DURATION_TEXT=$durationText
    GENERATED_AT=(Get-Date -Format "MMM d, yyyy h:mm tt")
    REPOSITORY=$repository
    BRANCH=$branch
    COMMIT=$commit
    CHANGED_FILES=[string]$changedCount
    TRIGGERED_BY=$triggeredBy
    OVERALL_THEME=$overall.Theme
    OVERALL_ICON=$shieldIcon
    OVERALL_TITLE=$overall.Title
    OVERALL_COPY=$overall.Copy
    RECOMMENDATION_ICON=$recommendationIcon
    RECOMMENDATION_TITLE=$overall.RecommendationTitle
    RECOMMENDATION_TEXT=$overall.RecommendationText
    BOTTOM_RECOMMENDATION=$overall.Bottom
    QUALITY_CHECKS_HTML=($qualityCards -join [Environment]::NewLine)
    BLOCKING_COUNT=[string]$blockingCount
    ADVISORY_COUNT=[string]$advisoryCount
    VIEW_ALL_BUTTON=$viewAllButton
    OVERVIEW_ISSUES_HTML=$overviewIssues
    TOTAL_FINDINGS=[string]$findings.Count
    FINDING_CARDS_HTML=$findingCards
    FINDINGS_JSON_BASE64=$findingsJsonBase64
}

foreach ($key in $values.Keys) {
    $value = if ($key -in @("OVERALL_ICON","RECOMMENDATION_ICON","QUALITY_CHECKS_HTML","VIEW_ALL_BUTTON","OVERVIEW_ISSUES_HTML","FINDING_CARDS_HTML","FINDINGS_JSON_BASE64")) {
        [string]$values[$key]
    } else {
        Convert-ToHtmlText $values[$key]
    }
    $template = $template.Replace("{{${key}}}", $value)
}

$leftovers = [regex]::Matches($template, "\{\{[A-Z0-9_]+\}\}") | ForEach-Object Value | Sort-Object -Unique
if (@($leftovers).Count -gt 0) {
    throw "Unresolved dashboard placeholders: $($leftovers -join ', ')"
}

$outputDirectory = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

Set-Content -LiteralPath $OutputPath -Value $template -Encoding UTF8
Write-Host "[SUCCESS] Dashboard generated: $OutputPath" -ForegroundColor Green
Write-Host "Status=$overallStatus Findings=$($findings.Count) MustFix=$blockingCount Recommendations=$advisoryCount"