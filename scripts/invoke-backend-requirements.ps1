param(
    [Parameter(Mandatory = $true)]
    [string]$ToolkitRoot,

    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot,

    [Parameter(Mandatory = $true)]
    [string]$ChangedFilesPath,

    [Parameter(Mandatory = $true)]
    [string]$BaseReference,

    [Parameter(Mandatory = $true)]
    [string]$HeadReference,

    [Parameter(Mandatory = $true)]
    [string]$ResultPath,

    [Parameter(Mandatory = $true)]
    [string]$RawOutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$commonScript = Join-Path $PSScriptRoot "common.ps1"
if (-not (Test-Path -LiteralPath $commonScript -PathType Leaf)) {
    throw "Required common script was not found: $commonScript"
}
. $commonScript

function Normalize-RepositoryPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return $Path.Replace('\\', '/').TrimStart('.', '/').Trim()
}

function Get-AddedDiffLines {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$BaseReference,
        [Parameter(Mandatory = $true)][string]$HeadReference,
        [Parameter(Mandatory = $true)][string]$File
    )

    Push-Location $RepositoryRoot
    try {
        $diff = @(git diff --no-ext-diff --unified=0 "$BaseReference...$HeadReference" -- $File 2>$null)
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to inspect PR diff for $File"
        }

        return @(
            $diff |
                Where-Object {
                    $_ -match '^\+' -and
                    $_ -notmatch '^\+\+\+'
                } |
                ForEach-Object { $_.Substring(1) }
        )
    }
    finally {
        Pop-Location
    }
}

function Test-NewFileInPr {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$BaseReference,
        [Parameter(Mandatory = $true)][string]$HeadReference,
        [Parameter(Mandatory = $true)][string]$File
    )

    Push-Location $RepositoryRoot
    try {
        $added = @(git diff --name-only --diff-filter=A "$BaseReference...$HeadReference" -- $File 2>$null)
        return ($LASTEXITCODE -eq 0 -and $added.Count -gt 0)
    }
    finally {
        Pop-Location
    }
}

function Get-LineNumberForText {
    param(
        [Parameter(Mandatory = $true)][string[]]$Lines,
        [Parameter(Mandatory = $true)][string]$Pattern
    )

    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match $Pattern) {
            return ($i + 1)
        }
    }

    return $null
}

function Add-Finding {
    param(
        [Parameter(Mandatory = $true)][System.Collections.Generic.List[object]]$Findings,
        [Parameter(Mandatory = $true)][string]$Severity,
        [Parameter(Mandatory = $true)][string]$Message,
        [Parameter(Mandatory = $true)][string]$File,
        [Parameter(Mandatory = $false)][AllowNull()][object]$Line,
        [Parameter(Mandatory = $true)][string]$RuleId
    )

    [void]$Findings.Add([pscustomobject]@{
        severity = $Severity
        message = $Message
        file = $File
        line = $Line
        ruleId = $RuleId
    })
}

$startedAt = Get-Date
$findings = New-Object 'System.Collections.Generic.List[object]'
$analyzedFiles = New-Object 'System.Collections.Generic.List[string]'
$rawChecks = New-Object 'System.Collections.Generic.List[object]'

try {
    $resolvedRepositoryRoot = Resolve-QaPath -Path $RepositoryRoot
    $resolvedChangedFilesPath = Resolve-QaPath -Path $ChangedFilesPath
    $resolvedResultPath = Resolve-QaPath -Path $ResultPath -AllowMissing
    $resolvedRawOutputPath = Resolve-QaPath -Path $RawOutputPath -AllowMissing

    $changedDoc = Read-QaJson -Path $resolvedChangedFilesPath
    $changedFiles = if ($changedDoc -is [System.Array]) { @($changedDoc) } else { @($changedDoc.files) }

    $candidateFiles = @(
        $changedFiles |
            ForEach-Object { Normalize-RepositoryPath -Path ([string]$_) } |
            Where-Object {
                $_ -match '^src/.+\.ts$' -and
                $_ -notmatch '\.spec\.ts$' -and
                $_ -notmatch '\.d\.ts$' -and
                $_ -notmatch '(^|/)(generated|dist|coverage)/' -and
                $_ -notmatch '(^|/)prisma/migrations/'
            } |
            Sort-Object -Unique
    )

    foreach ($file in $candidateFiles) {
        $absolute = Resolve-QaPath -Path $file -BasePath $resolvedRepositoryRoot -AllowMissing
        if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) {
            continue
        }

        $isRelevantLayer = (
            $file -match '\.controller\.ts$' -or
            $file -match '(^|/)dto/.+\.dto\.ts$' -or
            $file -match '\.service\.ts$' -or
            $file -match '\.(mapper|util|utils|guard|pipe|interceptor)\.ts$'
        )
        if (-not $isRelevantLayer) {
            continue
        }

        [void]$analyzedFiles.Add($file)
        $content = Get-Content -LiteralPath $absolute -Raw
        $lines = @(Get-Content -LiteralPath $absolute)
        $addedLines = @(Get-AddedDiffLines -RepositoryRoot $resolvedRepositoryRoot -BaseReference $BaseReference -HeadReference $HeadReference -File $file)
        $addedText = ($addedLines -join "`n")
        $isNewFile = Test-NewFileInPr -RepositoryRoot $resolvedRepositoryRoot -BaseReference $BaseReference -HeadReference $HeadReference -File $file

        $check = [ordered]@{
            file = $file
            newFile = $isNewFile
            addedLineCount = $addedLines.Count
            layer = "other"
            triggeredRules = @()
        }

        if ($file -match '\.controller\.ts$') {
            $check.layer = "controller"
            $routeChanged = $addedText -match '@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\('
            if ($routeChanged) {
                if ($content -notmatch '@ApiTags\s*\(') {
                    $severity = if ($isNewFile) { "HIGH" } else { "MEDIUM" }
                    Add-Finding -Findings $findings -Severity $severity -Message "Changed controller exposes API routes but has no @ApiTags() Swagger metadata." -File $file -Line (Get-LineNumberForText -Lines $lines -Pattern '@Controller\s*\(') -RuleId "backend.swagger.controller.tags"
                    $check.triggeredRules += "backend.swagger.controller.tags"
                }

                if ($addedText -match '@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(') {
                    $hasOperation = $content -match '@ApiOperation\s*\('
                    $hasResponse = $content -match '@Api(OkResponse|CreatedResponse|AcceptedResponse|NoContentResponse|BadRequestResponse|UnauthorizedResponse|ForbiddenResponse|NotFoundResponse|ConflictResponse|Response)\s*\('
                    if (-not $hasOperation) {
                        Add-Finding -Findings $findings -Severity "MEDIUM" -Message "PR adds or changes a controller route, but no @ApiOperation() metadata was found in this controller. Review the changed endpoint documentation." -File $file -Line $null -RuleId "backend.swagger.controller.operation"
                        $check.triggeredRules += "backend.swagger.controller.operation"
                    }
                    if (-not $hasResponse) {
                        Add-Finding -Findings $findings -Severity "MEDIUM" -Message "PR adds or changes a controller route, but no Swagger response decorator was found in this controller. Document the response where the endpoint contract changed." -File $file -Line $null -RuleId "backend.swagger.controller.response"
                        $check.triggeredRules += "backend.swagger.controller.response"
                    }
                }

                if (
                    $content -match '@UseGuards\s*\([^\)]*(Jwt|Auth)' -and
                    $content -notmatch '@ApiBearerAuth\s*\('
                ) {
                    Add-Finding -Findings $findings -Severity "MEDIUM" -Message "Controller appears to use JWT/auth guards but has no @ApiBearerAuth() documentation. Confirm authentication is documented for the changed API routes." -File $file -Line (Get-LineNumberForText -Lines $lines -Pattern '@UseGuards\s*\(') -RuleId "backend.swagger.controller.bearer-auth"
                    $check.triggeredRules += "backend.swagger.controller.bearer-auth"
                }
            }
        }
        elseif ($file -match '(^|/)dto/.+\.dto\.ts$') {
            $check.layer = "dto"
            $propertyChanged = $addedText -match '(?m)^\s*(readonly\s+)?[A-Za-z_$][A-Za-z0-9_$]*[!?]?\s*:'
            $apiFacingName = $file -match '/(create|update|save|patch|request|response|query|filter|params?)[^/]*\.dto\.ts$'

            if ($propertyChanged -and $apiFacingName) {
                if ($content -notmatch '@ApiProperty(Optional)?\s*\(') {
                    Add-Finding -Findings $findings -Severity "MEDIUM" -Message "Changed API DTO fields were detected, but this DTO has no @ApiProperty()/@ApiPropertyOptional() metadata. Review Swagger documentation for the changed fields." -File $file -Line $null -RuleId "backend.swagger.dto.metadata"
                    $check.triggeredRules += "backend.swagger.dto.metadata"
                }

                $isResponseDto = $file -match '/response[^/]*\.dto\.ts$'
                if (-not $isResponseDto -and $content -notmatch '@(Is|Validate|Matches|Min|Max|Length|Array|IsOptional|ValidateIf)[A-Za-z0-9_]*\s*\(') {
                    Add-Finding -Findings $findings -Severity "MEDIUM" -Message "Changed input DTO fields were detected, but no class-validator decorators were found. Confirm runtime validation is intentionally not required before merging." -File $file -Line $null -RuleId "backend.dto.validation"
                    $check.triggeredRules += "backend.dto.validation"
                }
            }
        }
        elseif ($file -match '\.service\.ts$') {
            $check.layer = "service"

            # Deliberately conservative: only flag likely business-risk changes.
            $businessPattern = '(?i)(\$transaction|journal|ledger|debit|credit|balance|reconcil|vat|tax|currency|exchange|inventory|stock|quantity|amount|total|discount|permission|authori[sz]|duplicate|approve|approval|status|transition|rollback|posting|posted)'
            $meaningfulBehaviorChanged = $addedText -match $businessPattern

            if ($meaningfulBehaviorChanged) {
                $specPath = $file -replace '\.service\.ts$', '.service.spec.ts'
                $specAbsolute = Resolve-QaPath -Path $specPath -BasePath $resolvedRepositoryRoot -AllowMissing
                $specExists = Test-Path -LiteralPath $specAbsolute -PathType Leaf

                if (-not $specExists) {
                    Add-Finding -Findings $findings -Severity "MEDIUM" -Message "PR changes likely business-critical service behavior, but no colocated service Jest spec was detected. Review whether the changed behavior already has meaningful Jest coverage; add focused tests if it does not. Simple CRUD/wiring changes do not require artificial tests." -File $file -Line $null -RuleId "backend.jest.service.business-logic"
                    $check.triggeredRules += "backend.jest.service.business-logic"
                }
            }
        }
        elseif ($file -match '\.(mapper|util|utils|guard|pipe|interceptor)\.ts$') {
            $check.layer = "conditional-logic"
            $logicChanged = $addedText -match '(?i)(\bif\s*\(|\bswitch\s*\(|\bthrow\s+new\b|\bfor(each)?\s*\(|\bwhile\s*\(|\breturn\b.*[+\-*\/%]|permission|currency|amount|total|status|normalize|transform)'

            if ($logicChanged) {
                $specPath = $file -replace '\.ts$', '.spec.ts'
                $specAbsolute = Resolve-QaPath -Path $specPath -BasePath $resolvedRepositoryRoot -AllowMissing
                if (-not (Test-Path -LiteralPath $specAbsolute -PathType Leaf)) {
                    Add-Finding -Findings $findings -Severity "LOW" -Message "Non-trivial logic may have changed in this helper/application-rule file and no colocated Jest spec was found. Review whether a focused behavioral test would add value." -File $file -Line $null -RuleId "backend.jest.conditional-logic"
                    $check.triggeredRules += "backend.jest.conditional-logic"
                }
            }
        }

        [void]$rawChecks.Add([pscustomobject]$check)
    }

    $highCount = @($findings | Where-Object { $_.severity -in @("HIGH", "CRITICAL") }).Count
    $advisoryCount = @($findings | Where-Object { $_.severity -notin @("HIGH", "CRITICAL") }).Count

    if ($analyzedFiles.Count -eq 0) {
        $status = "SKIPPED"
        $blocking = $false
        $summary = "No changed backend files matched the Swagger/Jest requirement layers."
    }
    elseif ($highCount -gt 0) {
        $status = "FAILED"
        $blocking = $true
        $summary = "$highCount high-confidence backend requirement issue(s) must be fixed; $advisoryCount advisory item(s) also detected."
    }
    elseif ($findings.Count -gt 0) {
        $status = "WARNING"
        $blocking = $false
        $summary = "$($findings.Count) backend requirement review item(s) detected. These are advisory unless a high-confidence rule is violated."
    }
    else {
        $status = "PASSED"
        $blocking = $false
        $summary = "Changed backend files passed the conservative Swagger/Jest requirement checks."
    }

    $durationMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
    $result = New-QaResult `
        -Tool "Backend Requirements" `
        -Category "BACKEND_REQUIREMENTS" `
        -Status $status `
        -Blocking $blocking `
        -ExitCode $(if ($blocking) { 1 } else { 0 }) `
        -FindingCount $findings.Count `
        -DurationMs $durationMs `
        -Summary $summary `
        -Details $findings.ToArray() `
        -Metadata @{
            changedFileCount = $changedFiles.Count
            analyzedFileCount = $analyzedFiles.Count
            blockingFindingCount = $highCount
            advisoryFindingCount = $advisoryCount
            policy = "PR-diff conservative"
        }

    Write-QaJson -Value $result -Path $resolvedResultPath -ValidateAsQaResult | Out-Null
    Write-QaJson -Value @{
        tool = "Backend Requirements"
        policy = "PR-diff conservative"
        baseReference = $BaseReference
        headReference = $HeadReference
        analyzedFiles = $analyzedFiles.ToArray()
        checks = $rawChecks.ToArray()
    } -Path $resolvedRawOutputPath | Out-Null

    if ($blocking) {
        Write-QaLog -Level "ERROR" -Message $summary
        exit 1
    }

    Write-QaLog -Level "SUCCESS" -Message $summary
    exit 0
}
catch {
    $durationMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
    $message = $_.Exception.Message

    $errorResult = New-QaResult `
        -Tool "Backend Requirements" `
        -Category "BACKEND_REQUIREMENTS" `
        -Status "ERROR" `
        -Blocking $true `
        -ExitCode 1 `
        -FindingCount 0 `
        -DurationMs $durationMs `
        -Summary "Backend requirements analyzer failed: $message" `
        -Details @() `
        -Metadata @{ error = $message }

    if ($null -ne $ResultPath) {
        Write-QaJson -Value $errorResult -Path $ResultPath -ValidateAsQaResult | Out-Null
    }

    Write-Error $message
    exit 1
}