# start-windows.ps1 — Launch sinain system on Windows
# Usage: .\start-windows.ps1 [-NoSense] [-NoOverlay]

param(
    [switch]$NoSense,
    [switch]$NoOverlay
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "[sinain] Starting sinain system on Windows..." -ForegroundColor Cyan

# 1. Start sinain-core
Write-Host "[sinain] Starting sinain-core..." -ForegroundColor Green
$coreJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location "$dir\sinain-core"
    & npm start
} -ArgumentList $scriptDir

# Wait for core to be ready
$maxWait = 30
$waited = 0
while ($waited -lt $maxWait) {
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:9500/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($response) {
            Write-Host "[sinain] sinain-core is ready" -ForegroundColor Green
            break
        }
    } catch {}
    Start-Sleep -Seconds 1
    $waited++
}

if ($waited -ge $maxWait) {
    Write-Host "[sinain] WARNING: sinain-core may not be ready after ${maxWait}s" -ForegroundColor Yellow
}

# 2. Start sense_client (unless -NoSense)
$senseJob = $null
if (-not $NoSense) {
    Write-Host "[sinain] Starting sense_client..." -ForegroundColor Green
    $senseJob = Start-Job -ScriptBlock {
        param($dir)
        Set-Location $dir
        & python -m sense_client
    } -ArgumentList $scriptDir
}

# 3. Start overlay (unless -NoOverlay)
$overlayJob = $null
if (-not $NoOverlay) {
    Write-Host "[sinain] Starting overlay..." -ForegroundColor Green
    $overlayJob = Start-Job -ScriptBlock {
        param($dir)
        Set-Location "$dir\sinain-hud-enterprise"
        & flutter run -d windows
    } -ArgumentList $scriptDir
}

Write-Host ""
Write-Host "[sinain] System started. Press Ctrl+C to stop all services." -ForegroundColor Cyan
Write-Host "[sinain] Core:    http://localhost:9500" -ForegroundColor White
Write-Host "[sinain] Health:  http://localhost:9500/health" -ForegroundColor White
Write-Host ""

# Wait and forward output
try {
    while ($true) {
        foreach ($job in @($coreJob, $senseJob, $overlayJob)) {
            if ($job -and $job.HasMoreData) {
                Receive-Job $job
            }
        }
        Start-Sleep -Seconds 1
    }
} finally {
    Write-Host "`n[sinain] Shutting down..." -ForegroundColor Yellow
    @($coreJob, $senseJob, $overlayJob) | Where-Object { $_ } | Stop-Job -PassThru | Remove-Job
    Write-Host "[sinain] Goodbye" -ForegroundColor Cyan
}
