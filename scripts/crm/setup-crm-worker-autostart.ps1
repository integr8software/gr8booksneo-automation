$ErrorActionPreference = "Stop"

$TaskName = "Gr8BooksNeo CRM Worker"
$RepoRoot = "D:\Gr8BooksNeo\gr8booksneo-automation"
$WorkerScript = Join-Path $RepoRoot "scripts\crm\run-local-crm-worker.mjs"
$StartScript = Join-Path $RepoRoot "scripts\crm\start-crm-worker.ps1"
$StateDir = Join-Path $RepoRoot ".local\crm-worker"
$ConfigPath = Join-Path $StateDir "autostart-config.json"
$UsernamePath = Join-Path $StateDir "crm-username.txt"
$PasswordPath = Join-Path $StateDir "crm-password.txt"

Write-Host "Gr8BooksNeo CRM Worker auto-start setup" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $WorkerScript)) {
    throw "CRM worker not found: $WorkerScript"
}

if (-not (Test-Path $StartScript)) {
    throw "Startup script not found: $StartScript"
}

$NodeCommand = Get-Command node -ErrorAction Stop
$GhCommand = Get-Command gh -ErrorAction Stop

Write-Host "Node: $($NodeCommand.Source)"
Write-Host "GitHub CLI: $($GhCommand.Source)"

& $GhCommand.Source auth status
if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI is not authenticated. Run: gh auth login"
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

$CrmUsername = Read-Host "CRM username/email"
if ([string]::IsNullOrWhiteSpace($CrmUsername)) {
    throw "CRM username cannot be empty."
}

$CrmPassword = Read-Host "CRM password" -AsSecureString

Set-Content -Path $UsernamePath -Value $CrmUsername.Trim() -Encoding UTF8
$CrmPassword |
    ConvertFrom-SecureString |
    Set-Content -Path $PasswordPath -Encoding UTF8

$Config = @{
    repoRoot = $RepoRoot
    nodePath = $NodeCommand.Source
    ghPath   = $GhCommand.Source
} | ConvertTo-Json

Set-Content -Path $ConfigPath -Value $Config -Encoding UTF8

$PowerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
$TaskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$Action = New-ScheduledTaskAction `
    -Execute $PowerShellExe `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$StartScript`"" `
    -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser

$Principal = New-ScheduledTaskPrincipal `
    -UserId $TaskUser `
    -LogonType Interactive `
    -RunLevel Limited

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Starts the Gr8BooksNeo local CRM publishing worker automatically at Windows logon." `
    -Force | Out-Null

Write-Host ""
Write-Host "Auto-start task created successfully." -ForegroundColor Green
Write-Host "Task: $TaskName"
Write-Host "User: $TaskUser"
Write-Host ""
Write-Host "Starting the worker now for validation..."

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$Task = Get-ScheduledTask -TaskName $TaskName
$Info = Get-ScheduledTaskInfo -TaskName $TaskName

Write-Host "Task state: $($Task.State)"
Write-Host "Last result: $($Info.LastTaskResult)"
Write-Host ""
Write-Host "The CRM password is stored using Windows DPAPI and can only be decrypted by this Windows user on this machine."