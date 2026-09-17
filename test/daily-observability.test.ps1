#!/usr/bin/env pwsh
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("mcp-doctor-observability-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $root | Out-Null
try {
  $mcpRegistry = Join-Path $root "mcp-registry.json"
  $codexConfig = Join-Path $root "config.toml"
  $hermesConfig = Join-Path $root "config.yaml"
  $secretManifest = Join-Path $root "secret-manifest.json"
  $tokscale = Join-Path $root "tokscale.json"
  $budget = Join-Path $root "budget.json"
  $loops = Join-Path $root "loops"
  $loop = Join-Path $loops "daily"
  $subscriptions = Join-Path $root "subscriptions.json"
  $sentinel = Join-Path $root "SENTINEL-STATUS.md"
  $secretFindings = Join-Path $root "secret-findings-2026-08-14.md"
  $providerHealth = Join-Path $root "usage-2026-08-14.json"
  $output = Join-Path $root "output"
  $config = Join-Path $root "config.json"
  New-Item -ItemType Directory -Force -Path $loop | Out-Null

  @'
{"servers":{"alpha":{"status":"active","harnesses":["codex"]},"beta":{"status":"active","harnesses":["hermes"]}}}
'@ | Set-Content -LiteralPath $mcpRegistry -Encoding utf8
  @'
[mcp_servers.alpha]
command = "node"

[mcp_servers.rogue]
command = "node"

[mcp_servers.rogue.env]
API_TOKEN = "fixture-secret-should-never-appear"
'@ | Set-Content -LiteralPath $codexConfig -Encoding utf8
  @'
mcp_servers:
  beta:
    command: node
'@ | Set-Content -LiteralPath $hermesConfig -Encoding utf8
  @'
{"containsSecretValues":false,"updatedAt":"2026-08-14T00:00:00Z","vault":{"canonical":"fixture"},"groups":[{"id":"models","keys":["FIXTURE_ONE","FIXTURE_TWO"],"primaryTargets":["fixture"]}]}
'@ | Set-Content -LiteralPath $secretManifest -Encoding utf8
  $now = [DateTimeOffset]::UtcNow.ToString("o")
  @{ generated_at = $now; status = "pass"; entry_count = 1; totals = @{ input_tokens = 10; output_tokens = 3; cache_read_tokens = 2; cache_write_tokens = 1; reasoning_tokens = 0; total_tokens = 16; cost_usd = 0.01 } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tokscale -Encoding utf8
  '{"maxRunsPerDayPerLoop":30,"maxTotalRunsPerDayAllLoops":200,"warnRatio":0.7}' | Set-Content -LiteralPath $budget -Encoding utf8
  (@{ startedAt = $now; id = "fixture-run" } | ConvertTo-Json -Compress) | Set-Content -LiteralPath (Join-Path $loop "runs.jsonl") -Encoding utf8
  @'
{"containsSecretValues":false,"entries":[{"id":"alpha","name":"Alpha","category":"tool","status":"connected","billingStatus":"unknown","monthlyBudgetUsd":null,"actualMonthlyUsd":null,"includedIn":null,"owner":"fixture","lastVerifiedAt":"2026-08-14T00:00:00Z","integrationIds":["alpha"],"evidence":"fixture"}]}
'@ | Set-Content -LiteralPath $subscriptions -Encoding utf8
  "# Sentinel`n`n**Zone: GREEN**" | Set-Content -LiteralPath $sentinel -Encoding utf8
  "# Findings`n`nTotal findings across 1 repos: 0" | Set-Content -LiteralPath $secretFindings -Encoding utf8
  '{"providers":{"fixture":{"healthy":true}}}' | Set-Content -LiteralPath $providerHealth -Encoding utf8

  $configObject = @{
    schema = "starlight.dailyObservabilityConfig.v1"
    containsSecretValues = $false
    outputDirectory = $output
    mcpRegistryPath = $mcpRegistry
    secretManifestPath = $secretManifest
    tokscaleSummaryPath = $tokscale
    tokscaleLiveEnabled = $false
    tokscaleMaxAgeHours = 36
    costBudgetPath = $budget
    costWindowHours = 24
    loopRoot = $loops
    subscriptionRegistryPath = $subscriptions
    mcpConfigs = @(
      @{ harness = "codex"; format = "toml"; path = $codexConfig; required = $true },
      @{ harness = "hermes"; format = "yaml"; path = $hermesConfig; required = $true }
    )
    scheduledTasks = @()
    securityReports = @(
      @{ id = "sentinel"; type = "sentinel-markdown"; path = $sentinel; required = $true; maxAgeHours = 48 },
      @{ id = "secrets"; type = "secret-findings"; directory = $root; pattern = "secret-findings-*.md"; required = $true; maxAgeHours = 48 },
      @{ id = "provider"; type = "api-usage-json"; directory = $root; pattern = "usage-*.json"; required = $true; maxAgeHours = 48 }
    )
    railway = @{ enabled = $false; expectedProjects = @() }
  }
  $configObject | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $config -Encoding utf8

  $collector = Join-Path (Split-Path -Parent $PSScriptRoot) "ops/Invoke-DailyObservability.ps1"
  $json = & $collector -ConfigPath $config -NoNetwork -NoScheduledTasks -Json
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "Collector returned $LASTEXITCODE" }
  $raw = $json | Out-String
  if ($raw -match 'fixture-secret-should-never-appear') { throw "Credential leaked into output" }
  $report = $raw | ConvertFrom-Json
  if ($report.schema -ne "starlight.dailyObservability.v1") { throw "Wrong schema" }
  if ($report.mcp.uniqueServerCount -ne 3) { throw "Expected 3 unique servers" }
  if ($report.mcp.unregisteredServers -notcontains "rogue") { throw "Registry drift not detected" }
  if ($report.mcp.inlineCredentialRegistrationCount -ne 1) { throw "Inline credential risk not detected" }
  if ($report.cost.loopRuns.fleetRuns -ne 1) { throw "Recent loop run not counted" }
  if ($report.cost.usage.actualBilledCostKnown -ne $false) { throw "API-equivalent cost mislabeled as actual" }
  if (-not (Test-Path -LiteralPath (Join-Path $output "latest.json"))) { throw "Latest JSON receipt missing" }
  if (-not (Test-Path -LiteralPath (Join-Path $output "latest.md"))) { throw "Latest Markdown receipt missing" }
  if (-not (Test-Path -LiteralPath (Join-Path $output "latest.sha256"))) { throw "Latest receipt digest missing" }
  $digestLine = (Get-Content -Raw -LiteralPath (Join-Path $output "latest.sha256")).Trim()
  $expectedHash = ($digestLine -split '\s+', 2)[0].ToLowerInvariant()
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $output "latest.json")).Hash.ToLowerInvariant()
  if ($expectedHash -ne $actualHash) { throw "Latest receipt digest does not match latest.json" }
  & $collector -ConfigPath $config -NoNetwork -NoScheduledTasks -Json -Strict | Out-Null
  if ($LASTEXITCODE -ne 1) { throw "Strict amber posture should exit 1, got $LASTEXITCODE" }
  Write-Host "daily-observability.test.ps1: PASS"
} finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
