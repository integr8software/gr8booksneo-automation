Set-StrictMode -Version Latest

$ErrorActionPreference = "Stop"

# ============================================================
# Path helpers
# ============================================================

function Resolve-QaPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $false)]
        [string]$BasePath = (Get-Location).Path,

        [Parameter(Mandatory = $false)]
        [switch]$AllowMissing
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "Path cannot be empty."
    }

    $candidatePath = if ([System.IO.Path]::IsPathRooted($Path)) {
        $Path
    }
    else {
        Join-Path -Path $BasePath -ChildPath $Path
    }

    $absolutePath = [System.IO.Path]::GetFullPath($candidatePath)

    if (
        -not $AllowMissing -and
        -not (Test-Path -LiteralPath $absolutePath)
    ) {
        throw "Required path does not exist: $absolutePath"
    }

    return $absolutePath
}

function Ensure-QaDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $false)]
        [string]$BasePath = (Get-Location).Path
    )

    $absolutePath = Resolve-QaPath `
        -Path $Path `
        -BasePath $BasePath `
        -AllowMissing

    if (-not (Test-Path -LiteralPath $absolutePath -PathType Container)) {
        New-Item `
            -ItemType Directory `
            -Path $absolutePath `
            -Force |
            Out-Null
    }

    return $absolutePath
}

# ============================================================
# Logging
# ============================================================

function Write-QaLog {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("INFO", "SUCCESS", "WARNING", "ERROR")]
        [string]$Level,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $formattedMessage = "[$timestamp][$Level] $Message"

    switch ($Level) {
        "SUCCESS" {
            Write-Host $formattedMessage -ForegroundColor Green
        }

        "WARNING" {
            Write-Host $formattedMessage -ForegroundColor Yellow
        }

        "ERROR" {
            Write-Host $formattedMessage -ForegroundColor Red
        }

        default {
            Write-Host $formattedMessage
        }
    }
}

# ============================================================
# Process execution
# ============================================================

function Resolve-QaExecutable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath
    )

    if ([System.IO.Path]::IsPathRooted($FilePath)) {
        if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
            throw "Executable does not exist: $FilePath"
        }

        return [System.IO.Path]::GetFullPath($FilePath)
    }

    $command = Get-Command `
        -Name $FilePath `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($null -eq $command) {
        throw "Executable was not found in PATH: $FilePath"
    }

    return [string]$command.Source
}

function Invoke-QaProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $false)]
        [string[]]$Arguments = @(),

        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,

        [Parameter(Mandatory = $false)]
        [hashtable]$Environment = @{},

        [Parameter(Mandatory = $false)]
        [ValidateRange(1, 3600)]
        [int]$TimeoutSeconds = 600
    )

    $resolvedWorkingDirectory = Resolve-QaPath `
        -Path $WorkingDirectory

    $resolvedExecutable = Resolve-QaExecutable `
        -FilePath $FilePath

    $effectiveExecutable = $resolvedExecutable
    $effectiveArguments = @($Arguments)

    $extension = [System.IO.Path]::GetExtension(
        $resolvedExecutable
    ).ToLowerInvariant()

    # Windows .cmd and .bat files must be invoked through cmd.exe
    # when UseShellExecute is disabled.
    if ($extension -in @(".cmd", ".bat")) {
        $cmdExecutable = Resolve-QaExecutable `
            -FilePath "cmd.exe"

        $quotedExecutable = '"' + $resolvedExecutable + '"'

        $effectiveExecutable = $cmdExecutable
        $effectiveArguments = @(
            "/d",
            "/s",
            "/c",
            $quotedExecutable
        ) + @($Arguments)
    }

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $process = $null
    $timedOut = $false

    try {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()

        $startInfo.FileName = $effectiveExecutable
        $startInfo.WorkingDirectory = $resolvedWorkingDirectory
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true

        $escapedArguments = foreach ($argument in $effectiveArguments) {
    if ($argument -match '[\s"]') {
        '"' + ($argument -replace '"','\"') + '"'
    }
    else {
        $argument
    }
}

$startInfo.Arguments = ($escapedArguments -join ' ')

        foreach ($key in $Environment.Keys) {
            $startInfo.Environment[[string]$key] =
                [string]$Environment[$key]
        }

        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $startInfo

        if (-not $process.Start()) {
            throw "Failed to start process: $resolvedExecutable"
        }

        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()

        $completed = $process.WaitForExit($TimeoutSeconds * 1000)

        if (-not $completed) {
            $timedOut = $true

            try {
                $process.Kill($true)

                [void]$process.WaitForExit(5000)
            }
            catch {
                Write-QaLog `
                    -Level "WARNING" `
                    -Message "Unable to terminate the timed-out process cleanly."
            }
        }

        $standardOutput = ""

        if ($stdoutTask.IsCompleted) {
            $standardOutput = $stdoutTask.GetAwaiter().GetResult()
        }

        $standardError = ""

        if ($stderrTask.IsCompleted) {
            $standardError = $stderrTask.GetAwaiter().GetResult()
        }

        $stopwatch.Stop()

        if ($timedOut) {
            throw "Process timed out after $TimeoutSeconds seconds: $resolvedExecutable"
        }

        return [pscustomobject]@{
            FilePath         = $resolvedExecutable
            EffectiveCommand = $effectiveExecutable
            Arguments        = @($Arguments)
            WorkingDirectory = $resolvedWorkingDirectory
            ExitCode         = [int]$process.ExitCode
            StandardOut      = [string]$standardOutput
            StandardErr      = [string]$standardError
            DurationMs       = [int]$stopwatch.ElapsedMilliseconds
            TimedOut         = $false
        }
    }
    finally {
        if ($stopwatch.IsRunning) {
            $stopwatch.Stop()
        }

        if ($null -ne $process) {
            $process.Dispose()
        }
    }
}

# ============================================================
# Git / changed-file helpers
# ============================================================

function Get-QaChangedFiles {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot,

        [Parameter(Mandatory = $true)]
        [string]$BaseReference,

        [Parameter(Mandatory = $true)]
        [string]$HeadReference
    )

    $resolvedRepositoryRoot = Resolve-QaPath `
        -Path $RepositoryRoot

    $processResult = Invoke-QaProcess `
        -FilePath "git" `
        -Arguments @(
            "diff",
            "--name-only",
            "--diff-filter=ACMR",
            "$BaseReference...$HeadReference"
        ) `
        -WorkingDirectory $resolvedRepositoryRoot

    if ($processResult.ExitCode -ne 0) {
        $errorMessage = $processResult.StandardErr.Trim()

        if ([string]::IsNullOrWhiteSpace($errorMessage)) {
            $errorMessage =
                "Unable to determine the files changed by this Pull Request."
        }

        throw $errorMessage
    }

    return @(
        $processResult.StandardOut `
            -split "(`r`n|`n|`r)" |
            ForEach-Object {
                $_.Trim().Replace("\", "/")
            } |
            Where-Object {
                -not [string]::IsNullOrWhiteSpace($_)
            } |
            Sort-Object -Unique
    )
}

function Select-QaChangedFiles {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $false)]
        [string[]]$ChangedFiles = @(),

        [Parameter(Mandatory = $true)]
        [string[]]$IncludePatterns,

        [Parameter(Mandatory = $false)]
        [string[]]$ExcludePatterns = @()
    )

    $selectedFiles = foreach ($file in $ChangedFiles) {
        $included = $false
        $excluded = $false

        foreach ($pattern in $IncludePatterns) {
            if ($file -match $pattern) {
                $included = $true
                break
            }
        }

        if (-not $included) {
            continue
        }

        foreach ($pattern in $ExcludePatterns) {
            if ($file -match $pattern) {
                $excluded = $true
                break
            }
        }

        if (-not $excluded) {
            $file
        }
    }

    return @(
        $selectedFiles |
            Sort-Object -Unique
    )
}

function Convert-QaRepositoryPathToAbsolute {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot,

        [Parameter(Mandatory = $false)]
        [string[]]$RepositoryPaths = @(),

        [Parameter(Mandatory = $false)]
        [switch]$ExistingOnly
    )

    $resolvedRepositoryRoot = Resolve-QaPath `
        -Path $RepositoryRoot

    $absolutePaths = foreach ($repositoryPath in $RepositoryPaths) {
        $normalizedPath = $repositoryPath.Replace(
            "/",
            [System.IO.Path]::DirectorySeparatorChar
        )

        $absolutePath = Resolve-QaPath `
            -Path $normalizedPath `
            -BasePath $resolvedRepositoryRoot `
            -AllowMissing

        if (
            $ExistingOnly -and
            -not (Test-Path -LiteralPath $absolutePath)
        ) {
            continue
        }

        $absolutePath
    }

    return @(
        $absolutePaths |
            Sort-Object -Unique
    )
}

# ============================================================
# Standard analyzer result
# ============================================================

function New-QaDetail {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL")]
        [string]$Severity,

        [Parameter(Mandatory = $true)]
        [string]$Message,

        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [string]$File = $null,

        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [Nullable[int]]$Line = $null,

        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [string]$RuleId = $null
    )

    if ([string]::IsNullOrWhiteSpace($Message)) {
        throw "QA detail message cannot be empty."
    }

    return [ordered]@{
        severity = $Severity
        message  = $Message.Trim()
        file     = $File
        line     = $Line
        ruleId   = $RuleId
    }
}

function Assert-QaResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object]$Result
    )

    $requiredProperties = @(
        "schemaVersion",
        "tool",
        "category",
        "status",
        "blocking",
        "exitCode",
        "findingCount",
        "durationMs",
        "summary",
        "details",
        "metadata"
    )

    foreach ($propertyName in $requiredProperties) {
        if ($Result -is [System.Collections.IDictionary]) {
            if (-not $Result.Contains($propertyName)) {
                throw "QA result is missing required property: $propertyName"
            }
        }
        elseif ($null -eq $Result.PSObject.Properties[$propertyName]) {
            throw "QA result is missing required property: $propertyName"
        }
    }

    if ([string]$Result.schemaVersion -ne "1.0") {
        throw "Unsupported QA result schema version: $($Result.schemaVersion)"
    }

    $allowedCategories = @(
        "SECURITY",
        "CIRCULAR_DEPENDENCIES",
        "UNUSED_CODE",
        "BACKEND_REQUIREMENTS"
    )

    if ([string]$Result.category -notin $allowedCategories) {
        throw "Invalid QA result category: $($Result.category)"
    }

    $allowedStatuses = @(
        "PASSED",
        "WARNING",
        "FAILED",
        "SKIPPED",
        "ERROR"
    )

    if ([string]$Result.status -notin $allowedStatuses) {
        throw "Invalid QA result status: $($Result.status)"
    }

    if ([int]$Result.findingCount -lt 0) {
        throw "QA result findingCount cannot be negative."
    }

    if ([int]$Result.durationMs -lt 0) {
        throw "QA result durationMs cannot be negative."
    }

    if ([string]::IsNullOrWhiteSpace([string]$Result.tool)) {
        throw "QA result tool cannot be empty."
    }

    if ([string]::IsNullOrWhiteSpace([string]$Result.summary)) {
        throw "QA result summary cannot be empty."
    }

    switch ([string]$Result.status) {
        "PASSED" {
            if ([bool]$Result.blocking) {
                throw "PASSED results must not be blocking."
            }
        }

        "WARNING" {
            if ([bool]$Result.blocking) {
                throw "WARNING results must not be blocking."
            }
        }

        "SKIPPED" {
            if ([bool]$Result.blocking) {
                throw "SKIPPED results must not be blocking."
            }
        }

        "FAILED" {
            if (-not [bool]$Result.blocking) {
                throw "FAILED results must be blocking."
            }
        }

        "ERROR" {
            if (-not [bool]$Result.blocking) {
                throw "ERROR results must be blocking."
            }
        }
    }

    foreach ($detail in @($Result.details)) {
        $detailProperties = @(
            "severity",
            "message",
            "file",
            "line",
            "ruleId"
        )

        foreach ($detailProperty in $detailProperties) {
            if ($detail -is [System.Collections.IDictionary]) {
                if (-not $detail.Contains($detailProperty)) {
                    throw "QA detail is missing required property: $detailProperty"
                }
            }
            elseif (
                $null -eq $detail.PSObject.Properties[$detailProperty]
            ) {
                throw "QA detail is missing required property: $detailProperty"
            }
        }

        if (
            [string]$detail.severity -notin @(
                "INFO",
                "LOW",
                "MEDIUM",
                "HIGH",
                "CRITICAL"
            )
        ) {
            throw "Invalid QA detail severity: $($detail.severity)"
        }

        if ([string]::IsNullOrWhiteSpace([string]$detail.message)) {
            throw "QA detail message cannot be empty."
        }

        if (
            $null -ne $detail.line -and
            [int]$detail.line -lt 1
        ) {
            throw "QA detail line must be null or greater than zero."
        }
    }

    return $true
}

function New-QaResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Tool,

        [Parameter(Mandatory = $true)]
        [ValidateSet(
            "SECURITY",
            "CIRCULAR_DEPENDENCIES",
            "UNUSED_CODE",
            "BACKEND_REQUIREMENTS"
        )]
        [string]$Category,

        [Parameter(Mandatory = $true)]
        [ValidateSet(
            "PASSED",
            "WARNING",
            "FAILED",
            "SKIPPED",
            "ERROR"
        )]
        [string]$Status,

        [Parameter(Mandatory = $true)]
        [bool]$Blocking,

        [Parameter(Mandatory = $true)]
        [int]$ExitCode,

        [Parameter(Mandatory = $true)]
        [ValidateRange(0, [int]::MaxValue)]
        [int]$FindingCount,

        [Parameter(Mandatory = $true)]
        [ValidateRange(0, [int]::MaxValue)]
        [int]$DurationMs,

        [Parameter(Mandatory = $true)]
        [string]$Summary,

        [Parameter(Mandatory = $false)]
        [array]$Details = @(),

        [Parameter(Mandatory = $false)]
        [hashtable]$Metadata = @{}
    )

    if ([string]::IsNullOrWhiteSpace($Tool)) {
        throw "Tool cannot be empty."
    }

    if ([string]::IsNullOrWhiteSpace($Summary)) {
        throw "Summary cannot be empty."
    }

    switch ($Status) {
        "PASSED" {
            if ($Blocking) {
                throw "PASSED results must not be blocking."
            }
        }

        "WARNING" {
            if ($Blocking) {
                throw "WARNING results must not be blocking."
            }
        }

        "SKIPPED" {
            if ($Blocking) {
                throw "SKIPPED results must not be blocking."
            }
        }

        "FAILED" {
            if (-not $Blocking) {
                throw "FAILED results must be blocking."
            }
        }

        "ERROR" {
            if (-not $Blocking) {
                throw "ERROR results must be blocking."
            }
        }
    }

    $result = [ordered]@{
        schemaVersion = "1.0"
        tool           = $Tool.Trim()
        category       = $Category
        status         = $Status
        blocking       = $Blocking
        exitCode       = $ExitCode
        findingCount   = $FindingCount
        durationMs     = $DurationMs
        summary        = $Summary.Trim()
        details        = @($Details)
        metadata       = $Metadata
    }

    [void](Assert-QaResult -Result $result)

    return $result
}

# ============================================================
# JSON helpers
# ============================================================

function Write-QaJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value,

        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $false)]
        [ValidateRange(2, 100)]
        [int]$Depth = 30,

        [Parameter(Mandatory = $false)]
        [switch]$ValidateAsQaResult
    )

    if ($ValidateAsQaResult) {
        [void](Assert-QaResult -Result $Value)
    }

    $absolutePath = Resolve-QaPath `
        -Path $Path `
        -AllowMissing

    $parentDirectory = Split-Path `
        -Path $absolutePath `
        -Parent

    Ensure-QaDirectory `
        -Path $parentDirectory |
        Out-Null

    $json = $Value |
        ConvertTo-Json `
            -Depth $Depth

    [System.IO.File]::WriteAllText(
        $absolutePath,
        $json,
        [System.Text.UTF8Encoding]::new($false)
    )

    return $absolutePath
}

function Read-QaJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $false)]
        [switch]$ValidateAsQaResult
    )

    $absolutePath = Resolve-QaPath `
        -Path $Path

    $content = [System.IO.File]::ReadAllText(
        $absolutePath,
        [System.Text.Encoding]::UTF8
    )

    if ([string]::IsNullOrWhiteSpace($content)) {
        throw "JSON file is empty: $absolutePath"
    }

    try {
        $value = $content |
            ConvertFrom-Json
    }
    catch {
        throw "Invalid JSON file '$absolutePath': $($_.Exception.Message)"
    }

    if ($ValidateAsQaResult) {
        [void](Assert-QaResult -Result $value)
    }

    return $value
}

# ============================================================
# GitHub Actions helpers
# ============================================================

function Write-QaGitHubOutput {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($env:GITHUB_OUTPUT)) {
        return
    }

    if ($Name -notmatch "^[A-Za-z_][A-Za-z0-9_-]*$") {
        throw "Invalid GitHub output name: $Name"
    }

    if ($Value -match "(`r|`n)") {
        $delimiter = "QA_OUTPUT_$([Guid]::NewGuid().ToString('N'))"

        @(
            "$Name<<$delimiter"
            $Value
            $delimiter
        ) |
            Add-Content `
                -Path $env:GITHUB_OUTPUT `
                -Encoding UTF8

        return
    }

    "$Name=$Value" |
        Add-Content `
            -Path $env:GITHUB_OUTPUT `
            -Encoding UTF8
}

function Add-QaGitHubSummary {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $false)]
        [AllowNull()]
        [object]$Lines
    )

    if ($null -eq $Lines) {
        return
    }

    foreach ($line in @($Lines)) {
        $text = if ($null -eq $line) {
            ""
        }
        else {
            [string]$line
        }

        if ([string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY)) {
            Write-Host $text
        }
        else {
            Add-Content `
                -Path $env:GITHUB_STEP_SUMMARY `
                -Value $text `
                -Encoding UTF8
        }
    }
}