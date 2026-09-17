#!/usr/bin/env pwsh
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath,
  [string]$TaskName = "StarlightDailyObservability",
  [string]$At = "08:15",
  [switch]$RunNow
)

$ErrorActionPreference = "Stop"
if (-not $IsWindows) { throw "Windows Task Scheduler is required." }

$collector = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "Invoke-DailyObservability.ps1")).Path
$resolvedConfig = (Resolve-Path -LiteralPath ([Environment]::ExpandEnvironmentVariables($ConfigPath))).Path

$stableCandidates = @(
  "C:\Program Files\PowerShell\7\pwsh.exe",
  (Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\pwsh.exe")
)
$pwsh = $stableCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $pwsh) {
  $command = Get-Command pwsh -ErrorAction Stop
  $pwsh = $command.Source
}
if ($pwsh -match '(?i)\\\.cache\\codex-runtimes\\') {
  throw "Refusing to schedule an ephemeral Codex runtime PowerShell path. Install or select a stable pwsh.exe."
}

$time = [TimeSpan]::Parse($At)
$start = (Get-Date).Date.Add($time)
if ($start -lt (Get-Date)) { $start = $start.AddDays(1) }
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}"' -f $collector, $resolvedConfig

$action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At $start
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$description = "Read-only daily MCP, credential, automation, Railway inventory, security evidence, and cost posture. Writes redacted local receipts only."

$applied = $false
if ($PSCmdlet.ShouldProcess($TaskName, "Register or update daily observability task at $At")) {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Out-Null
  if ($RunNow) { Start-ScheduledTask -TaskName $TaskName }
  $applied = $true
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$info = if ($task) { $task | Get-ScheduledTaskInfo } else { $null }
[pscustomobject]@{
  taskName = $TaskName
  applied = $applied
  state = if ($task) { [string]$task.State } else { "not-registered" }
  nextRunTime = if ($info) { $info.NextRunTime } else { $start }
  executable = $pwsh
  collector = $collector
  config = $resolvedConfig
  runNowRequested = [bool]$RunNow
}
