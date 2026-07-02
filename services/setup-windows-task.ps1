# PowerShell script to setup Windows Task Scheduler for Daily Saint Reminder
# Right-click and "Run with PowerShell" to execute

# Check if running as admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "This script must be run as Administrator!" -ForegroundColor Red
    Write-Host "Please right-click and select 'Run with PowerShell'" -ForegroundColor Yellow
    exit
}

# Get the project path
$projectPath = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path $projectPath "services\daily-saint-reminder.js"
$nodePath = "node.exe"

Write-Host "Setting up Daily Saint Reminder Task..." -ForegroundColor Green
Write-Host "Project path: $projectPath" -ForegroundColor Cyan
Write-Host "Script path: $scriptPath" -ForegroundColor Cyan

# Create the task action
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $scriptPath -WorkingDirectory $projectPath

# Create the task trigger (6 AM daily)
$trigger = New-ScheduledTaskTrigger -Daily -At 6:00am

# Create the task settings
$settings = New-ScheduledTaskSettingsSet -RunOnlyIfNetworkAvailable -StartWhenAvailable

# Register the task
$taskName = "Daily-Saint-Reminder"
$taskDescription = "Fetches today's saint feast day and scientific event at 6 AM"

try {
    Register-ScheduledTask -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description $taskDescription `
        -Force | Out-Null

    Write-Host "`n✅ SUCCESS! Task created:" -ForegroundColor Green
    Write-Host "   Task Name: $taskName" -ForegroundColor Green
    Write-Host "   Runs at: 6:00 AM daily" -ForegroundColor Green
    Write-Host "   Logs to: $projectPath\services\logs\reminder.log" -ForegroundColor Green

    Write-Host "`nYou can:" -ForegroundColor Cyan
    Write-Host "  1. Check tomorrow after 6 AM for results" -ForegroundColor Cyan
    Write-Host "  2. Manually run now to test:" -ForegroundColor Cyan
    Write-Host "     node $scriptPath" -ForegroundColor Yellow
    Write-Host "  3. View logs:" -ForegroundColor Cyan
    Write-Host "     npm run reminder:logs" -ForegroundColor Yellow
}
catch {
    Write-Host "`n❌ Error creating task:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
}
