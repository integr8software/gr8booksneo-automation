$ErrorActionPreference = "Stop"

$RepoRoot = "D:\Gr8BooksNeo\gr8booksneo-automation"
$WorkerScript = Join-Path $RepoRoot "scripts\crm\run-local-crm-worker.mjs"
$StateDir = Join-Path $RepoRoot ".local\crm-worker"
$ConfigPath = Join-Path $StateDir "autostart-config.json"
$UsernamePath = Join-Path $StateDir "crm-username.txt"
$PasswordPath = Join-Path $StateDir "crm-password.txt"
$LogPath = Join-Path $StateDir "crm-worker.log"

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Write-WorkerLog {
    param([string]$Message)

    $Line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -Path $LogPath -Value $Line -Encoding UTF8
}

try {
    if (-not (Test-Path $WorkerScript)) {
        throw "CRM worker not found: $WorkerScript"
    }

    if (-not (Test-Path $ConfigPath)) {
        throw "Auto-start config not found. Run setup-crm-worker-autostart.ps1 first."
    }

    if (-not (Test-Path $UsernamePath) -or -not (Test-Path $PasswordPath)) {
        throw "CRM credentials not found. Run setup-crm-worker-autostart.ps1 first."
    }

    $Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json

    if (-not (Test-Path $Config.nodePath)) {
        throw "Configured Node executable not found: $($Config.nodePath)"
    }

    if (-not (Test-Path $Config.ghPath)) {
        throw "Configured GitHub CLI executable not found: $($Config.ghPath)"
    }

    $NodeDir = Split-Path $Config.nodePath -Parent
    $GhDir = Split-Path $Config.ghPath -Parent
    $env:PATH = "$NodeDir;$GhDir;$env:PATH"

    $env:CRM_USERNAME = (Get-Content $UsernamePath -Raw).Trim()

    $EncryptedPassword = (Get-Content $PasswordPath -Raw).Trim()
    $SecurePassword = ConvertTo-SecureString $EncryptedPassword
    $Credential = [pscredential]::new("crm", $SecurePassword)
    $env:CRM_PASSWORD = $Credential.GetNetworkCredential().Password

    $env:CRM_DRY_RUN = "false"

    Write-WorkerLog "Starting Gr8BooksNeo CRM worker."

    & $Config.nodePath $WorkerScript *>> $LogPath

    $ExitCode = $LASTEXITCODE
    Write-WorkerLog "CRM worker exited with code $ExitCode."
    exit $ExitCode
}
catch {
    Write-WorkerLog "CRM worker startup failed: $($_.Exception.Message)"
    throw
}
finally {
    Remove-Item Env:CRM_PASSWORD -ErrorAction SilentlyContinue
}