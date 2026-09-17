#!/usr/bin/env pwsh
<#
.SYNOPSIS
Build a redacted daily security, MCP, automation, and cost posture receipt.

.DESCRIPTION
This collector is read-only against agent configs and providers. It never reads
Railway variables, prints credential values, changes MCP registrations, or mutates
external services. Its only writes are atomic JSON and Markdown receipts in the
configured local output directory.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath,
  [string]$OutputDirectory = "",
  [switch]$NoNetwork,
  [switch]$NoScheduledTasks,
  [switch]$Json,
  [switch]$Strict
)

$ErrorActionPreference = "Stop"

function Resolve-ExpandedPath {
  param([string]$PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return $null }
  $expanded = [Environment]::ExpandEnvironmentVariables($PathValue)
  if ($expanded -eq "~") { $expanded = $HOME }
  elseif ($expanded.StartsWith("~/") -or $expanded.StartsWith("~\")) {
    $expanded = Join-Path $HOME $expanded.Substring(2)
  }
  return [System.IO.Path]::GetFullPath($expanded)
}

function Protect-Text {
  param([AllowNull()][string]$Text)
  if ($null -eq $Text) { return $null }
  $safe = $Text
  $safe = $safe -replace '(?i)(Bearer\s+)[A-Za-z0-9._~+/-]+=*', '$1[redacted]'
  $safe = $safe -replace '(?i)((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+', '$1[redacted]'
  $safe = $safe -replace 'AIzaSy[A-Za-z0-9_-]{20,}', '[redacted:google-key]'
  $safe = $safe -replace '(?:sk-ant-|sk-|xai-|gh[pousr]_|npm_|re_)[A-Za-z0-9._-]{16,}', '[redacted:credential]'
  $safe = $safe -replace 'eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[redacted:jwt]'
  return $safe
}

function Get-UtcDate {
  param($Value)
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
  try { return ([DateTimeOffset]::Parse([string]$Value)).ToUniversalTime() } catch { return $null }
}

function Get-AgeHours {
  param($DateValue)
  $date = Get-UtcDate $DateValue
  if ($null -eq $date) { return $null }
  return [math]::Round(([DateTimeOffset]::UtcNow - $date).TotalHours, 2)
}

function Test-InlineCredentialValue {
  param([string]$Name, $Value)
  if ($Name -notmatch '(?i)(api[_-]?key|token|secret|password|authorization|credential)') { return $false }
  if ($null -eq $Value) { return $false }
  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) { return $false }
  if ($text -match '(?i)(YOUR_|REPLACE_|\$\{|\$env:|env:|process\.env|\[redacted\]|<[^>]+>)') { return $false }
  return $true
}

function Test-ObjectForInlineCredential {
  param($Value)
  if ($null -eq $Value) { return $false }
  if ($Value -is [System.Collections.IDictionary] -or $Value -is [pscustomobject]) {
    foreach ($property in $Value.PSObject.Properties) {
      if (Test-InlineCredentialValue $property.Name $property.Value) { return $true }
      if (Test-ObjectForInlineCredential $property.Value) { return $true }
    }
  } elseif ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
    foreach ($item in $Value) {
      if (Test-ObjectForInlineCredential $item) { return $true }
    }
  }
  return $false
}

function Add-Finding {
  param(
    [System.Collections.Generic.List[object]]$List,
    [ValidateSet("critical", "high", "medium", "info")][string]$Severity,
    [string]$Domain,
    [string]$Code,
    [string]$Message,
    [string]$Evidence = ""
  )
  $List.Add([pscustomobject]@{
    severity = $Severity
    domain = $Domain
    code = $Code
    message = Protect-Text $Message
    evidence = Protect-Text $Evidence
  }) | Out-Null
}

function Get-JsonMcpRecords {
  param([object]$Descriptor, [System.Collections.Generic.List[object]]$Findings)
  $path = Resolve-ExpandedPath $Descriptor.path
  if (-not (Test-Path -LiteralPath $path)) {
    if ($Descriptor.required) {
      Add-Finding $Findings "high" "mcp" "config-missing" "Required MCP config is missing for $($Descriptor.harness)." $path
    }
    return @()
  }
  try { $root = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json } catch {
    Add-Finding $Findings "high" "mcp" "config-invalid" "MCP config could not be parsed for $($Descriptor.harness)." $path
    return @()
  }

  $records = [System.Collections.Generic.List[object]]::new()
  $containers = @()
  foreach ($key in @("mcpServers", "servers", "mcp")) {
    $property = $root.PSObject.Properties[$key]
    if ($property -and $property.Value) {
      $containers += [pscustomobject]@{ scope = "global"; value = $property.Value }
    }
  }
  if ($root.PSObject.Properties["projects"] -and $root.projects) {
    foreach ($project in $root.projects.PSObject.Properties) {
      if ($project.Value.mcpServers) {
        $containers += [pscustomobject]@{ scope = "project"; value = $project.Value.mcpServers }
      }
    }
  }

  foreach ($container in $containers) {
    foreach ($entry in $container.value.PSObject.Properties) {
      $definition = $entry.Value
      $disabled = ($definition.disabled -eq $true) -or ($definition.enabled -eq $false)
      $remote = [bool]($definition.url -or $definition.serverUrl -or $definition.type -match 'http|sse')
      $records.Add([pscustomobject]@{
        harness = [string]$Descriptor.harness
        name = [string]$entry.Name
        scope = [string]$container.scope
        transport = if ($remote) { "remote" } else { "stdio" }
        disabled = $disabled
        inlineCredentialRisk = [bool](Test-ObjectForInlineCredential $definition)
        sourcePath = $path
      }) | Out-Null
    }
  }
  return @($records)
}

function Test-LiteralCredentialLine {
  param([string]$Line)
  if ($Line -notmatch '(?i)(api[_-]?key|token|secret|password|authorization|credential)\s*=\s*(.+)$') { return $false }
  $value = $Matches[2].Trim().TrimEnd(',').Trim('"', "'")
  return (Test-InlineCredentialValue "credential" $value)
}

function Get-TomlMcpRecords {
  param([object]$Descriptor, [System.Collections.Generic.List[object]]$Findings)
  $path = Resolve-ExpandedPath $Descriptor.path
  if (-not (Test-Path -LiteralPath $path)) {
    if ($Descriptor.required) { Add-Finding $Findings "high" "mcp" "config-missing" "Required MCP config is missing for $($Descriptor.harness)." $path }
    return @()
  }
  $sections = [ordered]@{}
  $current = $null
  foreach ($line in Get-Content -LiteralPath $path) {
    if ($line -match '^\[mcp_servers\."?([^"\]]+)"?\]\s*$') {
      $current = $Matches[1]
      if (-not $sections.Contains($current)) { $sections[$current] = [System.Collections.Generic.List[string]]::new() }
      continue
    }
    if ($line -match '^\[') { $current = $null; continue }
    if ($current) { $sections[$current].Add($line) | Out-Null }
  }
  $records = @()
  foreach ($sectionName in $sections.Keys) {
    if ($sectionName.EndsWith(".env")) { continue }
    $lines = @($sections[$sectionName])
    $envSection = "$sectionName.env"
    if ($sections.Contains($envSection)) { $lines += @($sections[$envSection]) }
    $text = $lines -join "`n"
    $records += [pscustomobject]@{
      harness = [string]$Descriptor.harness
      name = [string]$sectionName
      scope = "global"
      transport = if ($text -match '(?m)^\s*(url|endpoint)\s*=') { "remote" } else { "stdio" }
      disabled = [bool]($text -match '(?mi)^\s*(disabled\s*=\s*true|enabled\s*=\s*false)')
      inlineCredentialRisk = [bool](@($lines | Where-Object { Test-LiteralCredentialLine $_ }).Count -gt 0)
      sourcePath = $path
    }
  }
  return $records
}

function Get-YamlMcpRecords {
  param([object]$Descriptor, [System.Collections.Generic.List[object]]$Findings)
  $path = Resolve-ExpandedPath $Descriptor.path
  if (-not (Test-Path -LiteralPath $path)) {
    if ($Descriptor.required) { Add-Finding $Findings "high" "mcp" "config-missing" "Required MCP config is missing for $($Descriptor.harness)." $path }
    return @()
  }
  $servers = [ordered]@{}
  $inside = $false
  $current = $null
  foreach ($line in Get-Content -LiteralPath $path) {
    if ($line -match '^mcp_servers:\s*$') { $inside = $true; $current = $null; continue }
    if ($inside -and $line -match '^\S') { $inside = $false; $current = $null }
    if (-not $inside) { continue }
    if ($line -match '^  ([A-Za-z0-9_.-]+):\s*$') {
      $current = $Matches[1]
      $servers[$current] = [System.Collections.Generic.List[string]]::new()
      continue
    }
    if ($current) { $servers[$current].Add($line) | Out-Null }
  }
  $records = @()
  foreach ($name in $servers.Keys) {
    $lines = @($servers[$name])
    $text = $lines -join "`n"
    $records += [pscustomobject]@{
      harness = [string]$Descriptor.harness
      name = [string]$name
      scope = "global"
      transport = if ($text -match '(?mi)^\s*(url|endpoint):') { "remote" } else { "stdio" }
      disabled = [bool]($text -match '(?mi)^\s*(disabled:\s*true|enabled:\s*false)')
      inlineCredentialRisk = [bool](@($lines | Where-Object { Test-LiteralCredentialLine ($_ -replace ':', '=') }).Count -gt 0)
      sourcePath = $path
    }
  }
  return $records
}

function Get-McpPosture {
  param($Config, [System.Collections.Generic.List[object]]$Findings)
  $records = @()
  foreach ($descriptor in @($Config.mcpConfigs)) {
    switch ([string]$descriptor.format) {
      "json" { $records += Get-JsonMcpRecords $descriptor $Findings }
      "toml" { $records += Get-TomlMcpRecords $descriptor $Findings }
      "yaml" { $records += Get-YamlMcpRecords $descriptor $Findings }
      default { Add-Finding $Findings "medium" "mcp" "format-unsupported" "Unsupported MCP config format for $($descriptor.harness)." ([string]$descriptor.format) }
    }
  }
  $active = @($records | Where-Object { -not $_.disabled })
  $inlineRisks = @($active | Where-Object inlineCredentialRisk)
  if ($inlineRisks.Count -gt 0) {
    Add-Finding $Findings "high" "credentials" "inline-mcp-credentials" "$($inlineRisks.Count) active MCP registration(s) appear to contain literal credential values. Move them to environment or vault references." "Values were not collected."
  }

  $duplicates = @(
    $active | Group-Object harness, name | Where-Object Count -gt 1 | ForEach-Object {
      [pscustomobject]@{ harness = $_.Group[0].harness; name = $_.Group[0].name; registrations = $_.Count }
    }
  )
  if ($duplicates.Count -gt 0) { Add-Finding $Findings "medium" "mcp" "duplicate-registrations" "$($duplicates.Count) same-harness MCP duplicate(s) were detected." }

  $registryPath = Resolve-ExpandedPath $Config.mcpRegistryPath
  $registry = $null
  if ($registryPath -and (Test-Path -LiteralPath $registryPath)) {
    try { $registry = Get-Content -Raw -LiteralPath $registryPath | ConvertFrom-Json } catch {
      Add-Finding $Findings "high" "mcp" "registry-invalid" "The MCP registry could not be parsed." $registryPath
    }
  } else {
    Add-Finding $Findings "high" "mcp" "registry-missing" "The configured MCP registry is missing." $registryPath
  }

  $registryNames = @()
  $registeredMissing = @()
  if ($registry -and $registry.servers) {
    $registryNames = @($registry.servers.PSObject.Properties.Name)
    foreach ($serverProperty in $registry.servers.PSObject.Properties) {
      $server = $serverProperty.Value
      if ($server.status -eq "active" -and -not ($active.name -contains $serverProperty.Name)) {
        $registeredMissing += $serverProperty.Name
      }
    }
  }
  $configuredNames = @($active.name | Sort-Object -Unique)
  $unregistered = @($configuredNames | Where-Object { $_ -notin $registryNames })
  if ($unregistered.Count -gt 0) {
    Add-Finding $Findings "high" "mcp" "registry-drift" "$($unregistered.Count) configured MCP server name(s) are absent from the declared registry." "Names are available in the redacted receipt."
  }
  if ($registeredMissing.Count -gt 0) {
    Add-Finding $Findings "medium" "mcp" "active-registry-missing" "$($registeredMissing.Count) registry-active server(s) are not present in inspected harness configs."
  }

  return [pscustomobject]@{
    inspectedConfigCount = @($Config.mcpConfigs).Count
    registrationCount = $records.Count
    activeRegistrationCount = $active.Count
    uniqueServerCount = $configuredNames.Count
    harnesses = @($active | Group-Object harness | ForEach-Object { [pscustomobject]@{ harness = $_.Name; registrations = $_.Count; uniqueServers = @($_.Group.name | Sort-Object -Unique).Count } })
    servers = @($configuredNames)
    unregisteredServers = @($unregistered)
    registryActiveButUnconfigured = @($registeredMissing)
    duplicateRegistrations = @($duplicates)
    inlineCredentialRegistrationCount = $inlineRisks.Count
    healthMode = "config-only"
  }
}

function Get-CredentialPosture {
  param($Config, [System.Collections.Generic.List[object]]$Findings)
  $path = Resolve-ExpandedPath $Config.secretManifestPath
  if (-not $path -or -not (Test-Path -LiteralPath $path)) {
    Add-Finding $Findings "high" "credentials" "manifest-missing" "The credential manifest is missing." $path
    return [pscustomobject]@{ status = "missing"; manifestPath = $path; containsSecretValues = $null; expectedKeyCount = 0; localPresenceCount = 0; groups = @() }
  }
  try { $manifest = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json } catch {
    Add-Finding $Findings "critical" "credentials" "manifest-invalid" "The credential manifest could not be parsed." $path
    return [pscustomobject]@{ status = "invalid"; manifestPath = $path; containsSecretValues = $null; expectedKeyCount = 0; localPresenceCount = 0; groups = @() }
  }
  if ($manifest.containsSecretValues -ne $false) {
    Add-Finding $Findings "critical" "credentials" "manifest-secret-values" "The credential manifest does not explicitly declare containsSecretValues=false." $path
  }
  $groups = @()
  $allKeys = @()
  foreach ($group in @($manifest.groups)) {
    $keys = @($group.keys | Where-Object { $_ -is [string] })
    $allKeys += $keys
    $present = 0
    foreach ($key in $keys) {
      $hasValue = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key, "Process")) -or
                  -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key, "User")) -or
                  -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key, "Machine"))
      if ($hasValue) { $present++ }
    }
    $groups += [pscustomobject]@{ id = [string]$group.id; expectedKeyCount = $keys.Count; localPresenceCount = $present; targetCount = @($group.primaryTargets).Count }
  }
  $uniqueKeys = @($allKeys | Sort-Object -Unique)
  $localPresenceCount = 0
  foreach ($key in $uniqueKeys) {
    if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key, "Process")) -or
        -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key, "User")) -or
        -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key, "Machine"))) { $localPresenceCount++ }
  }
  Add-Finding $Findings "medium" "credentials" "rotation-metadata-gap" "The current manifest lists credential names and targets, but not per-credential owner, creation date, rotation date, or expiry."
  return [pscustomobject]@{
    status = "loaded"
    manifestPath = $path
    manifestUpdatedAt = $manifest.updatedAt
    manifestAgeHours = Get-AgeHours $manifest.updatedAt
    containsSecretValues = $manifest.containsSecretValues
    expectedKeyCount = $uniqueKeys.Count
    localPresenceCount = $localPresenceCount
    vault = [string]$manifest.vault.canonical
    rotationMetadataCoveragePct = 0
    groups = $groups
  }
}

function Get-ScheduledTaskPosture {
  param($Config, [System.Collections.Generic.List[object]]$Findings, [bool]$Skip)
  if ($Skip -or -not $IsWindows) { return [pscustomobject]@{ status = "skipped"; tasks = @() } }
  $rows = @()
  foreach ($expected in @($Config.scheduledTasks)) {
    $task = Get-ScheduledTask -TaskName $expected.name -ErrorAction SilentlyContinue
    if (-not $task) {
      $severity = if ($expected.required) { "high" } else { "medium" }
      Add-Finding $Findings $severity "automation" "task-missing" "Scheduled task $($expected.name) is missing."
      $rows += [pscustomobject]@{ name = $expected.name; status = "missing"; state = $null; lastRunTime = $null; lastResult = $null; nextRunTime = $null; ageHours = $null }
      continue
    }
    $info = $task | Get-ScheduledTaskInfo
    $age = if ($info.LastRunTime.Year -lt 2000) { $null } else { [math]::Round(((Get-Date) - $info.LastRunTime).TotalHours, 2) }
    $status = "healthy"
    if ($task.State -eq "Disabled") { $status = "disabled"; Add-Finding $Findings "high" "automation" "task-disabled" "Scheduled task $($expected.name) is disabled." }
    elseif ($null -ne $age -and $age -gt [double]$expected.maxAgeHours) { $status = "stale"; Add-Finding $Findings "high" "automation" "task-stale" "Scheduled task $($expected.name) is stale ($age hours since last run)." }
    elseif ($info.LastTaskResult -notin @(0, 267009, 267011, 267045)) { $status = "attention"; Add-Finding $Findings "high" "automation" "task-result" "Scheduled task $($expected.name) returned $($info.LastTaskResult)." }
    $rows += [pscustomobject]@{
      name = [string]$expected.name
      status = $status
      state = [string]$task.State
      lastRunTime = if ($info.LastRunTime.Year -lt 2000) { $null } else { $info.LastRunTime.ToString("o") }
      lastResult = [int64]$info.LastTaskResult
      nextRunTime = if ($info.NextRunTime.Year -lt 2000) { $null } else { $info.NextRunTime.ToString("o") }
      ageHours = $age
    }
  }
  return [pscustomobject]@{ status = "collected"; healthyCount = @($rows | Where-Object status -eq "healthy").Count; attentionCount = @($rows | Where-Object status -ne "healthy").Count; tasks = $rows }
}

function Get-SecurityReportPosture {
  param($Config, [System.Collections.Generic.List[object]]$Findings)
  $rows = @()
  foreach ($source in @($Config.securityReports)) {
    $path = $null
    if ($source.directory) {
      $directory = Resolve-ExpandedPath $source.directory
      if (Test-Path -LiteralPath $directory) {
        $file = Get-ChildItem -LiteralPath $directory -File -Filter $source.pattern -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($file) { $path = $file.FullName }
      }
    } else { $path = Resolve-ExpandedPath $source.path }
    if (-not $path -or -not (Test-Path -LiteralPath $path)) {
      $severity = if ($source.required) { "high" } else { "medium" }
      Add-Finding $Findings $severity "security" "report-missing" "Security evidence $($source.id) is missing." $path
      $rows += [pscustomobject]@{ id = $source.id; status = "missing"; ageHours = $null; findingCount = $null; sentinelFindingCount = $null; providerFailures = $null; failedProviders = @(); path = $path }
      continue
    }
    $item = Get-Item -LiteralPath $path
    $age = [math]::Round(((Get-Date) - $item.LastWriteTime).TotalHours, 2)
    $status = if ($age -gt [double]$source.maxAgeHours) { "stale" } else { "current" }
    if ($status -eq "stale") { Add-Finding $Findings "high" "security" "report-stale" "Security evidence $($source.id) is stale ($age hours old)." $path }
    $findingCount = $null
    $sentinelFindingCount = $null
    $providerFailures = $null
    $failedProviders = @()
    if ($source.type -eq "sentinel-markdown") {
      $text = Get-Content -Raw -LiteralPath $path
      $sentinelFindingCount = @([regex]::Matches($text, '(?m)^- \[(?:RED|YELLOW)\]')).Count
      $zone = if ($text -match '(?i)\*\*Zone:\s*(GREEN|YELLOW|RED)\*\*') { $Matches[1].ToUpperInvariant() } else { "UNKNOWN" }
      if ($zone -eq "RED") { Add-Finding $Findings "critical" "security" "sentinel-red" "Machine Sentinel is RED." $path }
      elseif ($zone -eq "YELLOW") { Add-Finding $Findings "high" "security" "sentinel-yellow" "Machine Sentinel is YELLOW." $path }
      elseif ($zone -eq "UNKNOWN") { Add-Finding $Findings "medium" "security" "sentinel-unknown" "Machine Sentinel zone could not be parsed." $path }
      $status = $zone.ToLowerInvariant()
    } elseif ($source.type -eq "secret-findings") {
      $text = Get-Content -Raw -LiteralPath $path
      if ($text -match '(?im)Total findings[^:]*:\s*(\d+)') { $findingCount = [int]$Matches[1] }
      if ($null -eq $findingCount) { Add-Finding $Findings "medium" "security" "secret-count-unknown" "The latest secret-scan result did not expose a parseable finding count." $path }
      elseif ($findingCount -gt 0) { Add-Finding $Findings "critical" "security" "secret-findings" "The latest secret scan reports $findingCount potential finding(s). Review the private source report." $path }
    } elseif ($source.type -eq "api-usage-json") {
      try {
        $usage = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
        $failedProviders = @($usage.providers.PSObject.Properties | Where-Object { $_.Value.healthy -eq $false } | ForEach-Object Name | Sort-Object)
        $providerFailures = $failedProviders.Count
        if ($providerFailures -gt 0) { Add-Finding $Findings "high" "credentials" "provider-health" "$providerFailures provider credential health check(s) are not healthy: $($failedProviders -join ', ')." $path }
      } catch { Add-Finding $Findings "high" "security" "usage-report-invalid" "The API usage health report could not be parsed." $path }
    }
    $rows += [pscustomobject]@{ id = [string]$source.id; status = $status; ageHours = $age; findingCount = $findingCount; sentinelFindingCount = $sentinelFindingCount; providerFailures = $providerFailures; failedProviders = $failedProviders; path = $path }
  }
  return [pscustomobject]@{ sources = $rows }
}

function Get-UsagePosture {
  param($Config, [System.Collections.Generic.List[object]]$Findings)
  if ($Config.tokscaleLiveEnabled -ne $false -and (Get-Command tokscale -ErrorAction SilentlyContinue)) {
    try {
      $output = & tokscale monthly --month --json --no-spinner 2>&1
      $exitCode = $LASTEXITCODE
      $text = ($output | Out-String).Trim()
      if ($exitCode -ne 0) { throw (Protect-Text $text) }
      $start = $text.IndexOf('{')
      $end = $text.LastIndexOf('}')
      if ($start -lt 0 -or $end -lt $start) { throw "Tokscale returned no JSON." }
      $live = $text.Substring($start, $end - $start + 1) | ConvertFrom-Json
      $month = Get-Date -Format "yyyy-MM"
      $entry = @($live.entries | Where-Object month -eq $month | Select-Object -Last 1)
      if (-not $entry) { $entry = @($live.entries | Select-Object -Last 1) }
      if (-not $entry) { throw "Tokscale returned no monthly entry." }
      $freshInput = [int64]$entry.input
      $outputTokens = [int64]$entry.output
      $cacheRead = [int64]$entry.cacheRead
      $cacheWrite = [int64]$entry.cacheWrite
      $processed = $freshInput + $outputTokens + $cacheRead + $cacheWrite
      $fresh = $freshInput + $outputTokens
      $cacheShare = if ($processed -gt 0) { [math]::Round(100 * ($cacheRead + $cacheWrite) / $processed, 1) } else { 0 }
      return [pscustomobject]@{
        status = "current"
        generatedAt = [DateTimeOffset]::Now.ToString("o")
        ageHours = 0
        window = [string]$entry.month
        sourceMode = "live-current-month"
        entryCount = [int64]$entry.messageCount
        freshInputTokens = $freshInput
        generatedOutputTokens = $outputTokens
        freshTokens = $fresh
        cacheReadTokens = $cacheRead
        cacheWriteTokens = $cacheWrite
        cacheSharePct = $cacheShare
        reasoningTokens = $null
        totalProcessedTokens = $processed
        apiEquivalentCostUsd = [math]::Round([double]$entry.cost, 2)
        actualBilledCostKnown = $false
        costLabel = "API-equivalent estimate; not an invoice or cash charge"
        path = "tokscale:monthly"
      }
    } catch {
      Add-Finding $Findings "medium" "cost" "usage-live-fallback" "Live Tokscale collection failed; the observer used the cached summary instead: $(Protect-Text $_.Exception.Message)"
    }
  }
  $path = Resolve-ExpandedPath $Config.tokscaleSummaryPath
  if (-not $path -or -not (Test-Path -LiteralPath $path)) {
    Add-Finding $Findings "high" "cost" "usage-missing" "The Tokscale summary is missing." $path
    return [pscustomobject]@{ status = "missing"; path = $path; actualBilledCostKnown = $false }
  }
  try { $summary = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json } catch {
    Add-Finding $Findings "high" "cost" "usage-invalid" "The Tokscale summary could not be parsed." $path
    return [pscustomobject]@{ status = "invalid"; path = $path; actualBilledCostKnown = $false }
  }
  $age = Get-AgeHours $summary.generated_at
  $maxAge = if ($Config.tokscaleMaxAgeHours) { [double]$Config.tokscaleMaxAgeHours } else { 36 }
  $status = if ($null -eq $age -or $age -gt $maxAge) { "stale" } else { [string]$summary.status }
  if ($status -eq "stale") { Add-Finding $Findings "high" "cost" "usage-stale" "Tokscale usage evidence is stale ($age hours old)." $path }
  return [pscustomobject]@{
    status = $status
    generatedAt = $summary.generated_at
    ageHours = $age
    entryCount = [int64]$summary.entry_count
    freshInputTokens = [int64]$summary.totals.input_tokens
    generatedOutputTokens = [int64]$summary.totals.output_tokens
    freshTokens = [int64]$summary.totals.input_tokens + [int64]$summary.totals.output_tokens
    cacheReadTokens = [int64]$summary.totals.cache_read_tokens
    cacheWriteTokens = [int64]$summary.totals.cache_write_tokens
    cacheSharePct = if ([int64]$summary.totals.total_tokens -gt 0) { [math]::Round(100 * ([int64]$summary.totals.cache_read_tokens + [int64]$summary.totals.cache_write_tokens) / [int64]$summary.totals.total_tokens, 1) } else { 0 }
    reasoningTokens = [int64]$summary.totals.reasoning_tokens
    totalProcessedTokens = [int64]$summary.totals.total_tokens
    apiEquivalentCostUsd = [math]::Round([double]$summary.totals.cost_usd, 2)
    actualBilledCostKnown = $false
    costLabel = "API-equivalent estimate; not an invoice or cash charge"
    path = $path
  }
}

function Get-LoopCostPosture {
  param($Config, [System.Collections.Generic.List[object]]$Findings)
  $budgetPath = Resolve-ExpandedPath $Config.costBudgetPath
  $loopRoot = Resolve-ExpandedPath $Config.loopRoot
  if (-not $budgetPath -or -not (Test-Path -LiteralPath $budgetPath) -or -not $loopRoot -or -not (Test-Path -LiteralPath $loopRoot)) {
    Add-Finding $Findings "medium" "cost" "run-budget-missing" "Run-count budget evidence is incomplete." "$budgetPath | $loopRoot"
    return [pscustomobject]@{ status = "missing"; fleetRuns = 0; loopCount = 0 }
  }
  $budget = Get-Content -Raw -LiteralPath $budgetPath | ConvertFrom-Json
  $windowHours = if ($Config.costWindowHours) { [int]$Config.costWindowHours } else { 24 }
  $cutoff = [DateTimeOffset]::UtcNow.AddHours(-$windowHours)
  $rows = @()
  $fleetRuns = 0
  foreach ($directory in Get-ChildItem -LiteralPath $loopRoot -Directory -ErrorAction SilentlyContinue) {
    $file = Join-Path $directory.FullName "runs.jsonl"
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $count = 0
    foreach ($line in Get-Content -LiteralPath $file) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try {
        $record = $line | ConvertFrom-Json
        $started = Get-UtcDate $record.startedAt
        if ($started -and $started -ge $cutoff) { $count++ }
      } catch { }
    }
    $fleetRuns += $count
    if ($count -gt 0) { $rows += [pscustomobject]@{ loop = $directory.Name; runs = $count } }
  }
  $status = "pass"
  if ($fleetRuns -ge [int]$budget.maxTotalRunsPerDayAllLoops) { $status = "fail"; Add-Finding $Findings "critical" "cost" "fleet-run-cap" "Loop fleet run count reached $fleetRuns/$($budget.maxTotalRunsPerDayAllLoops) in ${windowHours}h." }
  elseif ($fleetRuns -ge ([double]$budget.warnRatio * [int]$budget.maxTotalRunsPerDayAllLoops)) { $status = "warn"; Add-Finding $Findings "high" "cost" "fleet-run-warn" "Loop fleet run count reached $fleetRuns/$($budget.maxTotalRunsPerDayAllLoops) in ${windowHours}h." }
  foreach ($row in $rows) {
    if ($row.runs -ge [int]$budget.maxRunsPerDayPerLoop) { Add-Finding $Findings "critical" "cost" "loop-run-cap" "Loop $($row.loop) reached $($row.runs)/$($budget.maxRunsPerDayPerLoop) runs in ${windowHours}h." }
  }
  return [pscustomobject]@{ status = $status; windowHours = $windowHours; fleetRuns = $fleetRuns; fleetMax = [int]$budget.maxTotalRunsPerDayAllLoops; perLoopMax = [int]$budget.maxRunsPerDayPerLoop; activeLoops = @($rows | Sort-Object runs -Descending); loopCount = @(Get-ChildItem -LiteralPath $loopRoot -Directory).Count }
}

function Get-SubscriptionPosture {
  param($Config, $McpPosture, [System.Collections.Generic.List[object]]$Findings)
  $path = Resolve-ExpandedPath $Config.subscriptionRegistryPath
  if (-not $path -or -not (Test-Path -LiteralPath $path)) {
    Add-Finding $Findings "high" "cost" "subscription-registry-missing" "The subscription registry is missing." $path
    return [pscustomobject]@{ status = "missing"; entryCount = 0; actualMonthlyCostKnownUsd = 0; budgetedMonthlyUsd = 0; unknownActualCostCount = 0; entries = @() }
  }
  try { $registry = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json } catch {
    Add-Finding $Findings "high" "cost" "subscription-registry-invalid" "The subscription registry could not be parsed." $path
    return [pscustomobject]@{ status = "invalid"; entryCount = 0; actualMonthlyCostKnownUsd = 0; budgetedMonthlyUsd = 0; unknownActualCostCount = 0; entries = @() }
  }
  if ($registry.containsSecretValues -ne $false) { Add-Finding $Findings "critical" "credentials" "subscription-secrets" "The subscription registry must explicitly declare containsSecretValues=false." $path }
  $entries = @($registry.entries)
  $standalone = @($entries | Where-Object { -not $_.includedIn })
  $unknown = @($standalone | Where-Object { $_.billingStatus -notin @("free", "not-billable") -and $null -eq $_.actualMonthlyUsd })
  $budget = ($standalone | Where-Object { $null -ne $_.monthlyBudgetUsd } | Measure-Object monthlyBudgetUsd -Sum).Sum
  $actual = ($standalone | Where-Object { $null -ne $_.actualMonthlyUsd } | Measure-Object actualMonthlyUsd -Sum).Sum
  $marketSignalEntries = @($standalone | Where-Object { $null -ne $_.marketMonthlyUsdMin -or $null -ne $_.marketMonthlyUsdMax })
  $marketMinimum = ($marketSignalEntries | Where-Object { $null -ne $_.marketMonthlyUsdMin } | Measure-Object marketMonthlyUsdMin -Sum).Sum
  $marketMaximum = ($marketSignalEntries | Where-Object { $null -ne $_.marketMonthlyUsdMax } | Measure-Object marketMonthlyUsdMax -Sum).Sum
  if ($null -eq $budget) { $budget = 0 }
  if ($null -eq $actual) { $actual = 0 }
  if ($null -eq $marketMinimum) { $marketMinimum = 0 }
  if ($null -eq $marketMaximum) { $marketMaximum = 0 }
  if ($unknown.Count -gt 0) { Add-Finding $Findings "high" "cost" "actual-spend-unknown" "$($unknown.Count) standalone subscription/provider surface(s) lack current actual monthly cost evidence." "Populate invoice-backed actualMonthlyUsd; do not substitute API-equivalent estimates." }
  $stale = @($entries | Where-Object { $null -eq (Get-UtcDate $_.lastVerifiedAt) -or (Get-AgeHours $_.lastVerifiedAt) -gt (24 * 31) })
  if ($stale.Count -gt 0) { Add-Finding $Findings "medium" "cost" "subscription-review-stale" "$($stale.Count) subscription registry row(s) have not been verified in the last 31 days." }
  $mappedIds = @($entries | ForEach-Object { @($_.integrationIds) } | Sort-Object -Unique)
  $unmapped = @($McpPosture.servers | Where-Object { $_ -notin $mappedIds })
  return [pscustomobject]@{
    status = if ($unknown.Count -gt 0) { "incomplete" } else { "complete" }
    registryPath = $path
    entryCount = $entries.Count
    standaloneBillableCount = @($standalone | Where-Object { $_.billingStatus -notin @("free", "not-billable") }).Count
    includedSurfaceCount = @($entries | Where-Object includedIn).Count
    budgetedMonthlyUsd = [math]::Round([double]$budget, 2)
    actualMonthlyCostKnownUsd = [math]::Round([double]$actual, 2)
    observedPlanSignalCount = $marketSignalEntries.Count
    observedPlanMarketMinimumUsd = [math]::Round([double]$marketMinimum, 2)
    observedPlanMarketMaximumUsd = [math]::Round([double]$marketMaximum, 2)
    unknownActualCostCount = $unknown.Count
    staleReviewCount = $stale.Count
    unmappedMcpServers = $unmapped
    entries = @($entries | ForEach-Object { [pscustomobject]@{ id = $_.id; name = $_.name; category = $_.category; status = $_.status; billingStatus = $_.billingStatus; monthlyBudgetUsd = $_.monthlyBudgetUsd; actualMonthlyUsd = $_.actualMonthlyUsd; observedPlan = $_.observedPlan; marketMonthlyUsdMin = $_.marketMonthlyUsdMin; marketMonthlyUsdMax = $_.marketMonthlyUsdMax; includedIn = $_.includedIn; owner = $_.owner; lastVerifiedAt = $_.lastVerifiedAt; evidence = $_.evidence } })
  }
}

function Invoke-RailwayJson {
  param([string[]]$Arguments)
  $output = & railway @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  $text = ($output | Out-String).Trim()
  if ($exitCode -ne 0) { throw (Protect-Text $text) }
  $arrayStart = $text.IndexOf('[')
  $objectStart = $text.IndexOf('{')
  $starts = @($arrayStart, $objectStart) | Where-Object { $_ -ge 0 } | Sort-Object
  if ($starts.Count -eq 0) { throw "Railway returned no JSON." }
  $start = [int]$starts[0]
  $end = if ($text[$start] -eq '[') { $text.LastIndexOf(']') } else { $text.LastIndexOf('}') }
  if ($end -lt $start) { throw "Railway returned incomplete JSON." }
  return $text.Substring($start, $end - $start + 1) | ConvertFrom-Json
}

function Get-DynamicPropertyValue {
  param($Object, [string]$Name)
  if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) { return $null }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return $Object[$Name] }
    return $null
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($property) { return $property.Value }
  return $null
}

function Get-RailwayPosture {
  param($Config, [System.Collections.Generic.List[object]]$Findings, [bool]$Skip)
  if ($Skip -or -not $Config.railway.enabled) { return [pscustomobject]@{ status = "skipped"; projects = @() } }
  if (-not (Get-Command railway -ErrorAction SilentlyContinue)) {
    Add-Finding $Findings "high" "automation" "railway-cli-missing" "Railway CLI is not available."
    return [pscustomobject]@{ status = "missing-cli"; projects = @() }
  }
  try { $projects = @(Invoke-RailwayJson @("project", "list", "--json")) } catch {
    Add-Finding $Findings "high" "automation" "railway-unavailable" "Railway project inventory failed: $(Protect-Text $_.Exception.Message)"
    return [pscustomobject]@{ status = "unavailable"; projects = @() }
  }
  $allocationPath = Resolve-ExpandedPath $Config.railway.costAllocationPath
  $allocationPolicy = $null
  if ($allocationPath -and (Test-Path -LiteralPath $allocationPath)) {
    try {
      $allocationPolicy = Get-Content -Raw -LiteralPath $allocationPath | ConvertFrom-Json -AsHashtable
      if ($allocationPolicy.containsSecretValues -ne $false) {
        Add-Finding $Findings "critical" "credentials" "railway-allocation-secrets" "The Railway cost-allocation policy must declare containsSecretValues=false." $allocationPath
        $allocationPolicy = $null
      }
    } catch {
      Add-Finding $Findings "high" "cost" "railway-allocation-invalid" "The Railway cost-allocation policy could not be parsed." $allocationPath
    }
  } else {
    Add-Finding $Findings "medium" "cost" "railway-allocation-missing" "The Railway cost-allocation policy is missing; service spend cannot be separated into overhead and direct workload." $allocationPath
  }
  $rows = @()
  foreach ($project in $projects | Where-Object { -not $_.deletedAt }) {
    $inventoryServices = @($project.services.edges | ForEach-Object { $_.node })
    $environments = @($project.environments.edges | ForEach-Object { $_.node })
    $environment = @($environments | Where-Object { $_.name -match '(?i)^production$' } | Select-Object -First 1)
    if (-not $environment) { $environment = @($environments | Where-Object { $_.isEphemeral -ne $true } | Select-Object -First 1) }
    if (-not $environment) { $environment = @($environments | Select-Object -First 1) }
    $serviceHealth = @()

    if (-not $environment) {
      Add-Finding $Findings "high" "automation" "railway-environment-missing" "Railway project '$($project.name)' has no inspectable environment."
    } else {
      try {
        $serviceDetails = @(Invoke-RailwayJson @("service", "list", "--project", [string]$project.id, "--environment", [string]$environment.id, "--json"))
        foreach ($service in $serviceDetails) {
          $volumeUtilizations = @()
          foreach ($volume in @($service.volumes)) {
            if ($null -ne $volume.currentSizeMb -and $null -ne $volume.sizeMb -and [double]$volume.sizeMb -gt 0) {
              $volumeUtilizations += [math]::Round(100 * [double]$volume.currentSizeMb / [double]$volume.sizeMb, 1)
            }
          }
          $maxVolumePct = if ($volumeUtilizations.Count -gt 0) { [double](($volumeUtilizations | Measure-Object -Maximum).Maximum) } else { $null }
          $serviceHealth += [pscustomobject]@{
            name = [string]$service.name
            status = if ($service.status) { [string]$service.status } else { "UNKNOWN" }
            latestDeploymentStatus = if ($service.latestDeployment.status) { [string]$service.latestDeployment.status } else { "UNKNOWN" }
            deploymentStopped = [bool]$service.deploymentStopped
            replicas = [pscustomobject]@{
              configured = $service.replicas.configured
              running = $service.replicas.running
              crashed = $service.replicas.crashed
              exited = $service.replicas.exited
            }
            maxVolumeUtilizationPct = $maxVolumePct
          }
        }
      } catch {
        Add-Finding $Findings "high" "automation" "railway-service-health-unavailable" "Railway service health failed for project '$($project.name)': $(Protect-Text $_.Exception.Message)"
      }
    }

    $rows += [pscustomobject]@{
      name = [string]$project.name
      environment = if ($environment) { [string]$environment.name } else { $null }
      serviceCount = $inventoryServices.Count
      services = @($inventoryServices.name | Sort-Object)
      serviceHealth = @($serviceHealth | Sort-Object name)
    }
  }
  $expectedNames = @($Config.railway.expectedProjects)
  $missing = @($expectedNames | Where-Object { $_ -notin $rows.name })
  $unexpected = @($rows.name | Where-Object { $_ -notin $expectedNames })
  if ($missing.Count -gt 0) { Add-Finding $Findings "high" "automation" "railway-project-missing" "$($missing.Count) expected Railway project(s) are absent from the current account inventory." }
  if ($unexpected.Count -gt 0) { Add-Finding $Findings "medium" "cost" "railway-project-unmapped" "$($unexpected.Count) active Railway project(s) are not mapped in the observability policy." }

  $allServices = @($rows | ForEach-Object { $_.serviceHealth })
  $failedServices = @($allServices | Where-Object { $_.status -in @("FAILED", "CRASHED", "ERROR") })
  $stoppedServices = @($allServices | Where-Object deploymentStopped)
  $failedLatestDeployments = @($allServices | Where-Object { $_.latestDeploymentStatus -in @("FAILED", "CRASHED", "ERROR") -and $_.status -notin @("FAILED", "CRASHED", "ERROR") })
  $replicaIssues = @($allServices | Where-Object {
    ($null -ne $_.replicas.configured -and $null -ne $_.replicas.running -and [int]$_.replicas.running -lt [int]$_.replicas.configured) -or
    ($null -ne $_.replicas.crashed -and [int]$_.replicas.crashed -gt 0)
  })
  $unknownServices = @($allServices | Where-Object { $_.status -eq "UNKNOWN" })
  $volumeWarningPct = if ($Config.railway.volumeWarningPct) { [double]$Config.railway.volumeWarningPct } else { 80.0 }
  $volumeCriticalPct = if ($Config.railway.volumeCriticalPct) { [double]$Config.railway.volumeCriticalPct } else { 90.0 }
  $criticalVolumes = @($allServices | Where-Object { $null -ne $_.maxVolumeUtilizationPct -and [double]$_.maxVolumeUtilizationPct -ge $volumeCriticalPct })
  $warningVolumes = @($allServices | Where-Object { $null -ne $_.maxVolumeUtilizationPct -and [double]$_.maxVolumeUtilizationPct -ge $volumeWarningPct -and [double]$_.maxVolumeUtilizationPct -lt $volumeCriticalPct })

  if ($criticalVolumes.Count -gt 0) {
    $topVolume = $criticalVolumes | Sort-Object maxVolumeUtilizationPct -Descending | Select-Object -First 1
    Add-Finding $Findings "critical" "automation" "railway-volume-critical" "$($criticalVolumes.Count) Railway service volume(s) are at or above $volumeCriticalPct%; highest is '$($topVolume.name)' at $($topVolume.maxVolumeUtilizationPct)%." "Review retention, backups, and expansion before writes fail; this collector will not resize or delete data."
  }
  if ($warningVolumes.Count -gt 0) { Add-Finding $Findings "high" "automation" "railway-volume-warning" "$($warningVolumes.Count) Railway service volume(s) are at or above $volumeWarningPct%." }
  if ($failedServices.Count -gt 0) { Add-Finding $Findings "high" "automation" "railway-service-failed" "$($failedServices.Count) Railway service(s) report a failed/crashed status: $((@($failedServices.name) | Sort-Object -Unique) -join ', ')." }
  if ($stoppedServices.Count -gt 0) { Add-Finding $Findings "high" "automation" "railway-service-stopped" "$($stoppedServices.Count) Railway service(s) are stopped: $((@($stoppedServices.name) | Sort-Object -Unique) -join ', ')." }
  if ($failedLatestDeployments.Count -gt 0) { Add-Finding $Findings "high" "automation" "railway-latest-deployment-failed" "$($failedLatestDeployments.Count) running Railway service(s) have a failed latest deployment: $((@($failedLatestDeployments.name) | Sort-Object -Unique) -join ', ')." }
  if ($replicaIssues.Count -gt 0) { Add-Finding $Findings "high" "automation" "railway-replica-gap" "$($replicaIssues.Count) Railway service(s) have fewer running replicas than configured or report crashed replicas." }
  if ($unknownServices.Count -gt 0) { Add-Finding $Findings "medium" "automation" "railway-service-status-unknown" "$($unknownServices.Count) Railway service(s) have no current status." }

  $billing = [pscustomobject]@{
    status = "unavailable"
    periodStart = $null
    periodEnd = $null
    accruedUsageUsd = $null
    projectedPeriodUsd = $null
    optimizationTargetUsd = $null
    projectedSavingsToTargetUsd = $null
    computeSoftAlertUsd = $null
    computeHardLimitUsd = $null
    proposedHardLimitUsd = $null
    agentUsageUsd = $null
    agentHardLimitUsd = $null
    memorySharePct = $null
    overheadAccruedUsd = $null
    overheadProjectedUsd = $null
    overheadSharePct = $null
    unallocatedAccruedUsd = $null
    lineItems = @()
    projectCosts = @()
    serviceCosts = @()
    allocations = @()
  }
  try {
    $usageSummary = Invoke-RailwayJson @("usage", "--period", "current", "--json")
    $usageProjects = Invoke-RailwayJson @("usage", "projects", "--period", "current", "--json")
    $limitStatus = Invoke-RailwayJson @("usage", "limit", "status", "--json")
    $serviceCosts = @()
    foreach ($usageProject in @($usageProjects.projects)) {
      $detail = Invoke-RailwayJson @("usage", "projects", "--project", [string]$usageProject.id, "--period", "current", "--json")
      $projectPolicy = Get-DynamicPropertyValue $allocationPolicy.projects ([string]$usageProject.name)
      foreach ($serviceCost in @($detail.services)) {
        $servicePolicy = Get-DynamicPropertyValue $projectPolicy.services ([string]$serviceCost.name)
        $costClass = if ($servicePolicy.costClass) { [string]$servicePolicy.costClass } elseif ($projectPolicy.defaultCostClass) { [string]$projectPolicy.defaultCostClass } else { "unallocated" }
        $serviceCosts += [pscustomobject]@{
          project = [string]$usageProject.name
          service = [string]$serviceCost.name
          costClass = $costClass
          purpose = if ($servicePolicy.purpose) { [string]$servicePolicy.purpose } elseif ($projectPolicy.purpose) { [string]$projectPolicy.purpose } else { "unclassified" }
          priority = if ($servicePolicy.priority) { [string]$servicePolicy.priority } elseif ($projectPolicy.priority) { [string]$projectPolicy.priority } else { "review" }
          optimization = if ($servicePolicy.optimization) { [string]$servicePolicy.optimization } else { $null }
          accruedUsageUsd = [math]::Round([double]$serviceCost.totalDollars, 4)
          memoryUsd = [math]::Round([double]$serviceCost.memoryDollars, 4)
          cpuUsd = [math]::Round([double]$serviceCost.cpuDollars, 4)
          volumeUsd = [math]::Round([double]$serviceCost.volumeDollars, 4)
          egressUsd = [math]::Round([double]$serviceCost.egressDollars, 4)
        }
      }
    }
    $accrued = [double]$usageSummary.currentUsageDollars
    $projected = [double]$usageSummary.estimatedBillDollars
    $projectionMultiplier = if ($accrued -gt 0) { $projected / $accrued } else { 0 }
    $allocations = @($serviceCosts | Group-Object costClass | ForEach-Object {
      $amount = [double](($_.Group | Measure-Object accruedUsageUsd -Sum).Sum)
      [pscustomobject]@{ costClass = $_.Name; accruedUsageUsd = [math]::Round($amount, 2); projectedPeriodUsd = [math]::Round($amount * $projectionMultiplier, 2); sharePct = if ($accrued -gt 0) { [math]::Round(100 * $amount / $accrued, 1) } else { 0 } }
    } | Sort-Object accruedUsageUsd -Descending)
    $overheadClasses = @($allocationPolicy.overheadClasses)
    $overhead = [double](($serviceCosts | Where-Object { $_.costClass -in $overheadClasses } | Measure-Object accruedUsageUsd -Sum).Sum)
    $unallocated = [double](($serviceCosts | Where-Object costClass -eq "unallocated" | Measure-Object accruedUsageUsd -Sum).Sum)
    $memoryLine = @($usageSummary.lineItems | Where-Object label -eq "Memory" | Select-Object -First 1)
    $memoryShare = if ($accrued -gt 0 -and $memoryLine) { [math]::Round(100 * [double]$memoryLine.currentUsageDollars / $accrued, 1) } else { 0 }
    $target = if ($allocationPolicy.targets.monthlyOptimizationTargetUsd) { [double]$allocationPolicy.targets.monthlyOptimizationTargetUsd } else { $null }
    $softAlert = if ($null -ne $limitStatus.workspaceUsage.usageLimit.softLimitDollars) { $limitStatus.workspaceUsage.usageLimit.softLimitDollars } else { $limitStatus.workspaceUsage.usageLimit.softLimit }
    $hardLimit = if ($null -ne $limitStatus.workspaceUsage.usageLimit.hardLimitDollars) { $limitStatus.workspaceUsage.usageLimit.hardLimitDollars } else { $limitStatus.workspaceUsage.usageLimit.hardLimit }
    $proposedHardLimit = if ($allocationPolicy.targets.proposedHardLimitUsd) { [double]$allocationPolicy.targets.proposedHardLimitUsd } else { $null }
    $billing = [pscustomobject]@{
      status = "provider-current-period"
      periodStart = [string]$usageSummary.billingPeriod.start
      periodEnd = [string]$usageSummary.billingPeriod.end
      accruedUsageUsd = [math]::Round($accrued, 2)
      projectedPeriodUsd = [math]::Round($projected, 2)
      optimizationTargetUsd = $target
      projectedSavingsToTargetUsd = if ($null -ne $target) { [math]::Round([math]::Max(0, $projected - $target), 2) } else { $null }
      computeSoftAlertUsd = $softAlert
      computeHardLimitUsd = $hardLimit
      proposedHardLimitUsd = $proposedHardLimit
      agentUsageUsd = [math]::Round([double]$limitStatus.agentUsage.totalUsedDollars, 2)
      agentHardLimitUsd = [math]::Round([double]$limitStatus.agentUsage.hardLimitDollars, 2)
      memorySharePct = $memoryShare
      overheadAccruedUsd = [math]::Round($overhead, 2)
      overheadProjectedUsd = [math]::Round($overhead * $projectionMultiplier, 2)
      overheadSharePct = if ($accrued -gt 0) { [math]::Round(100 * $overhead / $accrued, 1) } else { 0 }
      unallocatedAccruedUsd = [math]::Round($unallocated, 2)
      lineItems = @($usageSummary.lineItems | ForEach-Object { [pscustomobject]@{ label = [string]$_.label; accruedUsageUsd = [math]::Round([double]$_.currentUsageDollars, 4) } })
      projectCosts = @($usageProjects.projects | ForEach-Object { [pscustomobject]@{ project = [string]$_.name; accruedUsageUsd = [math]::Round([double]$_.currentUsageDollars, 2); sharePct = [math]::Round(100 * [double]$_.share, 1) } })
      serviceCosts = @($serviceCosts | Sort-Object accruedUsageUsd -Descending)
      allocations = $allocations
    }
    if ($null -eq $hardLimit) { Add-Finding $Findings "high" "cost" "railway-compute-cap-missing" "Railway has no provider-enforced compute hard limit. The proposed $proposedHardLimit USD cap remains approval-gated because reaching it takes workloads offline." }
    if ($null -ne $target -and $projected -gt $target) { Add-Finding $Findings "high" "cost" "railway-above-target" "Railway projects to $([math]::Round($projected,2)) for the current period, $([math]::Round($projected-$target,2)) above the $target optimization target." }
    $maxMemoryShare = if ($allocationPolicy.targets.maxMemorySharePct) { [double]$allocationPolicy.targets.maxMemorySharePct } else { 80 }
    if ($memoryShare -gt $maxMemoryShare) { Add-Finding $Findings "high" "cost" "railway-memory-dominant" "Memory is $memoryShare% of accrued Railway usage; optimize always-on service RAM before CPU, egress, or volume." }
    $maxOverheadShare = if ($allocationPolicy.targets.maxOverheadSharePct) { [double]$allocationPolicy.targets.maxOverheadSharePct } else { 70 }
    if ($billing.overheadSharePct -gt $maxOverheadShare) { Add-Finding $Findings "medium" "cost" "railway-overhead-high" "Policy-classified Railway overhead is $($billing.overheadSharePct)% of accrued usage." }
    if ($unallocated -ge 0.01) { Add-Finding $Findings "medium" "cost" "railway-cost-unallocated" "USD $([math]::Round($unallocated,2)) of accrued Railway service usage has no cost allocation." }
  } catch {
    Add-Finding $Findings "high" "cost" "railway-billing-unavailable" "Railway provider billing evidence could not be collected: $(Protect-Text $_.Exception.Message)"
  }

  return [pscustomobject]@{
    status = "collected"
    projectCount = $rows.Count
    serviceCount = ($rows | Measure-Object serviceCount -Sum).Sum
    failedServiceCount = $failedServices.Count
    stoppedServiceCount = $stoppedServices.Count
    failedLatestDeploymentCount = $failedLatestDeployments.Count
    replicaIssueCount = $replicaIssues.Count
    unknownServiceCount = $unknownServices.Count
    criticalVolumeCount = $criticalVolumes.Count
    warningVolumeCount = $warningVolumes.Count
    volumeWarningPct = $volumeWarningPct
    volumeCriticalPct = $volumeCriticalPct
    missingExpectedProjects = $missing
    unmappedProjects = $unexpected
    projects = $rows
    billing = $billing
    costAllocationPath = $allocationPath
    costEvidence = if ($billing.status -eq "provider-current-period") { "provider current-period usage; not a finalized invoice" } else { "unavailable" }
  }
}

function Get-OverallStatus {
  param([System.Collections.Generic.List[object]]$Findings)
  if (@($Findings | Where-Object severity -eq "critical").Count -gt 0) { return "red" }
  if (@($Findings | Where-Object { $_.severity -in @("high", "medium") }).Count -gt 0) { return "amber" }
  return "green"
}

function Compare-StringSet {
  param($Before, $After)
  $beforeSet = @($Before | Where-Object { $_ } | ForEach-Object { [string]$_ } | Sort-Object -Unique)
  $afterSet = @($After | Where-Object { $_ } | ForEach-Object { [string]$_ } | Sort-Object -Unique)
  return [pscustomobject]@{
    added = @($afterSet | Where-Object { $_ -notin $beforeSet })
    removed = @($beforeSet | Where-Object { $_ -notin $afterSet })
  }
}

function Get-ChangePosture {
  param($Previous, $Mcp, $Credentials, $Tasks, $Railway, $Usage, $Subscriptions, [System.Collections.Generic.List[object]]$Findings)
  if (-not $Previous) {
    return [pscustomobject]@{ baseline = "created"; previousGeneratedAt = $null; mcp = [pscustomobject]@{ added = @(); removed = @() }; railwayProjects = [pscustomobject]@{ added = @(); removed = @() }; subscriptions = [pscustomobject]@{ added = @(); removed = @() }; credentialKeyDelta = $null; taskAttentionDelta = $null; processedTokenDelta = $null }
  }
  $mcpChange = Compare-StringSet $Previous.mcp.servers $Mcp.servers
  $railwayChange = Compare-StringSet @($Previous.automation.railway.projects.name) @($Railway.projects.name)
  $subscriptionChange = Compare-StringSet @($Previous.cost.subscriptions.entries.id) @($Subscriptions.entries.id)
  if ($mcpChange.added.Count -gt 0 -or $mcpChange.removed.Count -gt 0) {
    Add-Finding $Findings "medium" "mcp" "surface-changed" "The configured MCP surface changed since the previous receipt: $($mcpChange.added.Count) added, $($mcpChange.removed.Count) removed."
  }
  if ($railwayChange.added.Count -gt 0) {
    Add-Finding $Findings "high" "cost" "railway-surface-added" "$($railwayChange.added.Count) Railway project(s) appeared since the previous receipt. Verify owner, budget, and shutoff condition."
  }
  if ($subscriptionChange.added.Count -gt 0) {
    Add-Finding $Findings "medium" "cost" "subscription-surface-added" "$($subscriptionChange.added.Count) subscription registry row(s) were added since the previous receipt."
  }
  return [pscustomobject]@{
    baseline = "compared"
    previousGeneratedAt = $Previous.generatedAt
    previousOverallStatus = $Previous.overall.status
    mcp = $mcpChange
    railwayProjects = $railwayChange
    subscriptions = $subscriptionChange
    credentialKeyDelta = [int]$Credentials.expectedKeyCount - [int]$Previous.credentials.expectedKeyCount
    taskAttentionDelta = [int]$Tasks.attentionCount - [int]$Previous.automation.tasks.attentionCount
    processedTokenDelta = if ($null -ne $Usage.totalProcessedTokens -and $null -ne $Previous.cost.usage.totalProcessedTokens) { [int64]$Usage.totalProcessedTokens - [int64]$Previous.cost.usage.totalProcessedTokens } else { $null }
  }
}

function Get-TextSha256 {
  param([string]$Text)
  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Text)
  return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function ConvertTo-Markdown {
  param($Report)
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("# Daily Agentic Estate Observability")
  $lines.Add("")
  $lines.Add("- Generated: $($Report.generatedAt)")
  $lines.Add("- Timezone: $($Report.timezone)")
  $lines.Add("- Overall: **$($Report.overall.status.ToUpperInvariant())**")
  $lines.Add("- Findings: $($Report.overall.critical) critical · $($Report.overall.high) high · $($Report.overall.medium) medium")
  $lines.Add("")
  $lines.Add("## Control posture")
  $lines.Add("")
  $lines.Add("| Plane | Evidence | Posture |")
  $lines.Add("|---|---:|---|")
  $lines.Add("| MCP | $($Report.mcp.activeRegistrationCount) registrations / $($Report.mcp.uniqueServerCount) unique | $($Report.mcp.unregisteredServers.Count) unregistered; $($Report.mcp.inlineCredentialRegistrationCount) inline-credential risks |")
  $lines.Add("| Credentials | $($Report.credentials.expectedKeyCount) declared keys | $($Report.credentials.localPresenceCount) locally present; rotation metadata $($Report.credentials.rotationMetadataCoveragePct)% |")
  $lines.Add("| Scheduled tasks | $($Report.automation.tasks.tasks.Count) watched | $($Report.automation.tasks.attentionCount) need attention |")
  $lines.Add("| Railway | $($Report.automation.railway.projectCount) projects / $($Report.automation.railway.serviceCount) services | USD $($Report.automation.railway.billing.accruedUsageUsd) accrued; USD $($Report.automation.railway.billing.projectedPeriodUsd) projected; $($Report.automation.railway.billing.overheadSharePct)% overhead |")
  $lines.Add("| Usage | $($Report.cost.usage.freshTokens) fresh / $($Report.cost.usage.totalProcessedTokens) processed | $($Report.cost.usage.cacheSharePct)% cache; API-equivalent USD $($Report.cost.usage.apiEquivalentCostUsd), not cash |")
  $lines.Add("| Subscriptions | $($Report.cost.subscriptions.entryCount) rows | USD $($Report.cost.subscriptions.budgetedMonthlyUsd) budgeted; $($Report.cost.subscriptions.unknownActualCostCount) actual costs unknown |")
  $lines.Add("")
  $lines.Add("## Findings")
  $lines.Add("")
  if ($Report.findings.Count -eq 0) { $lines.Add("No findings.") }
  foreach ($finding in $Report.findings) {
    $lines.Add("- [$($finding.severity.ToUpperInvariant())] **$($finding.domain) / $($finding.code)** — $($finding.message)")
  }
  $lines.Add("")
  $lines.Add("## Change since previous receipt")
  $lines.Add("")
  if ($Report.changes.baseline -eq "created") {
    $lines.Add("Baseline created; there is no earlier comparable receipt.")
  } else {
    $lines.Add("- MCP: $($Report.changes.mcp.added.Count) added · $($Report.changes.mcp.removed.Count) removed")
    $lines.Add("- Railway projects: $($Report.changes.railwayProjects.added.Count) added · $($Report.changes.railwayProjects.removed.Count) removed")
    $lines.Add("- Subscription rows: $($Report.changes.subscriptions.added.Count) added · $($Report.changes.subscriptions.removed.Count) removed")
    $lines.Add("- Task attention delta: $($Report.changes.taskAttentionDelta)")
    $lines.Add("- Processed-token delta: $($Report.changes.processedTokenDelta)")
  }
  $lines.Add("")
  $lines.Add("## Cost truth")
  $lines.Add("")
  $lines.Add("Railway reports USD $($Report.automation.railway.billing.accruedUsageUsd) accrued and USD $($Report.automation.railway.billing.projectedPeriodUsd) projected for its current billing period. This is provider billing evidence but not a finalized invoice. Policy-classified overhead is USD $($Report.automation.railway.billing.overheadAccruedUsd), or $($Report.automation.railway.billing.overheadSharePct)%.")
  $lines.Add("")
  $lines.Add("Tokscale reports API-equivalent value, not cash spend. Current-window fresh tokens are $($Report.cost.usage.freshTokens); cache traffic is $($Report.cost.usage.cacheSharePct)% of processed tokens. SaaS subscriptions and model-provider cash charges remain unknown until invoice evidence is entered in the subscription registry.")
  if ($Report.automation.railway.billing.serviceCosts.Count -gt 0) {
    $lines.Add("")
    $lines.Add("### Largest Railway cost services")
    $lines.Add("")
    $lines.Add("| Project / service | Accrued USD | Class | Optimization |")
    $lines.Add("|---|---:|---|---|")
    foreach ($service in @($Report.automation.railway.billing.serviceCosts | Select-Object -First 8)) {
      $lines.Add("| $($service.project) / $($service.service) | $($service.accruedUsageUsd) | $($service.costClass) | $($service.optimization) |")
    }
  }
  $lines.Add("")
  $lines.Add("## Safety boundary")
  $lines.Add("")
  $lines.Add("This collector did not read secret values into its output, inspect Railway variables, mutate services, revoke tokens, alter workflows, send alerts externally, or authorize agents.")
  return ($lines -join "`n")
}

function Write-AtomicText {
  param([string]$Path, [string]$Content)
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = Join-Path $directory ("." + [System.IO.Path]::GetFileName($Path) + "." + [guid]::NewGuid().ToString("N") + ".tmp")
  [System.IO.File]::WriteAllText($temporary, $Content, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::Move($temporary, $Path, $true)
}

$resolvedConfigPath = Resolve-ExpandedPath $ConfigPath
if (-not (Test-Path -LiteralPath $resolvedConfigPath)) { throw "Config not found: $resolvedConfigPath" }
$config = Get-Content -Raw -LiteralPath $resolvedConfigPath | ConvertFrom-Json
if ($config.containsSecretValues -ne $false) { throw "Observability config must declare containsSecretValues=false." }
$targetDirectory = if ($OutputDirectory) { Resolve-ExpandedPath $OutputDirectory } elseif ($config.outputDirectory) { Resolve-ExpandedPath $config.outputDirectory } else { Join-Path $HOME ".starlight/observability/daily" }
$previousLatestPath = Join-Path $targetDirectory "latest.json"
$previous = $null
if (Test-Path -LiteralPath $previousLatestPath) {
  try { $previous = Get-Content -Raw -LiteralPath $previousLatestPath | ConvertFrom-Json } catch { $previous = $null }
}
$findings = [System.Collections.Generic.List[object]]::new()

$mcp = Get-McpPosture $config $findings
$credentials = Get-CredentialPosture $config $findings
$taskPosture = Get-ScheduledTaskPosture $config $findings ([bool]$NoScheduledTasks)
$security = Get-SecurityReportPosture $config $findings
$usage = Get-UsagePosture $config $findings
$loopCost = Get-LoopCostPosture $config $findings
$subscriptions = Get-SubscriptionPosture $config $mcp $findings
$railway = Get-RailwayPosture $config $findings ([bool]$NoNetwork)
$changes = Get-ChangePosture $previous $mcp $credentials $taskPosture $railway $usage $subscriptions $findings
$runRate = if ($railway.billing.status -eq "provider-current-period") {
  [pscustomobject]@{
    label = "Modeled evidenced run-rate; provider projection plus observed subscription market range, not a finalized invoice"
    minimumUsd = [math]::Round([double]$railway.billing.projectedPeriodUsd + [double]$subscriptions.observedPlanMarketMinimumUsd, 2)
    maximumUsd = [math]::Round([double]$railway.billing.projectedPeriodUsd + [double]$subscriptions.observedPlanMarketMaximumUsd, 2)
    unknownSubscriptionCount = $subscriptions.unknownActualCostCount
  }
} else {
  [pscustomobject]@{ label = "Insufficient provider evidence"; minimumUsd = $null; maximumUsd = $null; unknownSubscriptionCount = $subscriptions.unknownActualCostCount }
}

$orderedFindings = @($findings | Sort-Object @{ Expression = { @("critical", "high", "medium", "info").IndexOf($_.severity) } }, domain, code)
$status = Get-OverallStatus $findings
$report = [pscustomobject]@{
  schema = "starlight.dailyObservability.v1"
  generatedAt = [DateTimeOffset]::Now.ToString("o")
  timezone = [TimeZoneInfo]::Local.Id
  configPath = $resolvedConfigPath
  overall = [pscustomobject]@{
    status = $status
    critical = @($orderedFindings | Where-Object severity -eq "critical").Count
    high = @($orderedFindings | Where-Object severity -eq "high").Count
    medium = @($orderedFindings | Where-Object severity -eq "medium").Count
    info = @($orderedFindings | Where-Object severity -eq "info").Count
  }
  mcp = $mcp
  credentials = $credentials
  security = $security
  automation = [pscustomobject]@{ tasks = $taskPosture; railway = $railway }
  cost = [pscustomobject]@{ usage = $usage; loopRuns = $loopCost; subscriptions = $subscriptions; runRate = $runRate }
  changes = $changes
  findings = $orderedFindings
  limitations = @(
    "MCP health is config-only; servers are not spawned by the daily observer.",
    "Tokscale cost is API-equivalent and may include cache traffic; it is not actual invoiced cash cost.",
    "Railway billing is live current-period usage and projection, not a finalized invoice; variables, logs, domains, and mutations are excluded.",
    "n8n and Make execution/spend require dedicated read-only usage adapters before they can be called covered.",
    "Credential presence is counted only; values are never emitted. Presence is not proof of least privilege or timely rotation."
  )
}

$jsonText = $report | ConvertTo-Json -Depth 30
if ($jsonText -match '(?:sk-ant-|sk-|xai-|gh[pousr]_|npm_|re_)[A-Za-z0-9._-]{16,}' -or $jsonText -match 'AIzaSy[A-Za-z0-9_-]{20,}') {
  throw "Fail closed: a credential-like value reached the serialized report. Nothing was written."
}
$markdown = ConvertTo-Markdown $report

$stamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
$jsonPath = Join-Path $targetDirectory "daily-observability-$stamp.json"
$markdownPath = Join-Path $targetDirectory "daily-observability-$stamp.md"
$latestJsonPath = Join-Path $targetDirectory "latest.json"
$latestMarkdownPath = Join-Path $targetDirectory "latest.md"
Write-AtomicText $jsonPath $jsonText
Write-AtomicText $latestJsonPath $jsonText
Write-AtomicText $markdownPath $markdown
Write-AtomicText $latestMarkdownPath $markdown
$digest = Get-TextSha256 $jsonText
Write-AtomicText "$jsonPath.sha256" "$digest  $([System.IO.Path]::GetFileName($jsonPath))`n"
Write-AtomicText (Join-Path $targetDirectory "latest.sha256") "$digest  latest.json`n"

if ($Json) { $jsonText } else {
  Write-Host "Daily observability: $($status.ToUpperInvariant())"
  Write-Host "MCP: $($mcp.activeRegistrationCount) active registrations, $($mcp.unregisteredServers.Count) registry drift, $($mcp.inlineCredentialRegistrationCount) inline credential risks"
  Write-Host "Cost: Railway USD $($railway.billing.accruedUsageUsd) accrued / USD $($railway.billing.projectedPeriodUsd) projected; $($railway.billing.overheadSharePct)% overhead; $($subscriptions.unknownActualCostCount) subscription actuals unknown"
  Write-Host "Report: $latestMarkdownPath"
}

if ($Strict) {
  if ($status -eq "red") { exit 2 }
  if ($status -eq "amber") { exit 1 }
}
