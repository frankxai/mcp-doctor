[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)][string]$RegistryPath,
  [Parameter(Mandatory = $true)][string]$CsvPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-ExpandedPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  $expanded = [Environment]::ExpandEnvironmentVariables($Path)
  if ($expanded.StartsWith("~/") -or $expanded.StartsWith("~\")) {
    $expanded = Join-Path $HOME $expanded.Substring(2)
  }
  return [System.IO.Path]::GetFullPath($expanded)
}

function Set-PropertyValue {
  param($Object, [string]$Name, $Value)
  $property = $Object.PSObject.Properties[$Name]
  if ($property) { $property.Value = $Value }
  else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Get-Decimal {
  param([string]$Value, [string]$Field)
  $parsed = 0.0
  if (-not [double]::TryParse($Value, [Globalization.NumberStyles]::Number, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
    throw "Invalid $Field value '$Value'. Use invariant USD decimals such as 19.99."
  }
  return [double]$parsed
}

$registryFile = Resolve-ExpandedPath $RegistryPath
$csvFile = Resolve-ExpandedPath $CsvPath
if (-not (Test-Path -LiteralPath $registryFile)) { throw "Registry not found: $registryFile" }
if (-not (Test-Path -LiteralPath $csvFile)) { throw "Invoice CSV not found: $csvFile" }

$registry = Get-Content -Raw -LiteralPath $registryFile | ConvertFrom-Json
if ($registry.containsSecretValues -ne $false) { throw "Registry must declare containsSecretValues=false." }
$rows = @(Import-Csv -LiteralPath $csvFile)
if ($rows.Count -eq 0) { throw "Invoice CSV contains no rows." }

$required = @("provider_id", "invoice_period", "gross_amount_usd", "tax_usd", "credits_usd", "net_amount_usd", "covered_months", "currency", "verified_at", "evidence_reference")
$headers = @($rows[0].PSObject.Properties.Name)
$missingHeaders = @($required | Where-Object { $_ -notin $headers })
if ($missingHeaders.Count -gt 0) { throw "Invoice CSV is missing required columns: $($missingHeaders -join ', ')." }

$duplicateIds = @($rows | Group-Object provider_id | Where-Object Count -gt 1)
if ($duplicateIds.Count -gt 0) { throw "Invoice CSV must contain at most one row per provider_id: $($duplicateIds.Name -join ', ')." }

$changes = @()
foreach ($row in $rows) {
  if ([string]::IsNullOrWhiteSpace($row.provider_id)) { throw "provider_id cannot be empty." }
  $entry = @($registry.entries | Where-Object id -eq $row.provider_id)
  if ($entry.Count -ne 1) { throw "provider_id '$($row.provider_id)' must match exactly one registry entry." }
  if ($row.invoice_period -notmatch '^\d{4}-(0[1-9]|1[0-2])$') { throw "invoice_period for '$($row.provider_id)' must be YYYY-MM." }
  if ($row.currency.ToUpperInvariant() -ne "USD") { throw "Currency '$($row.currency)' is not supported. Convert through invoice/bank evidence before importing; this script will not invent exchange rates." }
  $verified = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParseExact($row.verified_at, "yyyy-MM-dd", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$verified)) {
    throw "verified_at for '$($row.provider_id)' must be YYYY-MM-DD."
  }
  if ([string]::IsNullOrWhiteSpace($row.evidence_reference)) { throw "evidence_reference for '$($row.provider_id)' cannot be empty." }
  $gross = Get-Decimal $row.gross_amount_usd "gross_amount_usd"
  $tax = Get-Decimal $row.tax_usd "tax_usd"
  $credits = Get-Decimal $row.credits_usd "credits_usd"
  $net = Get-Decimal $row.net_amount_usd "net_amount_usd"
  $coveredMonths = Get-Decimal $row.covered_months "covered_months"
  if ($gross -lt 0 -or $tax -lt 0 -or $credits -lt 0 -or $net -lt 0 -or $coveredMonths -le 0) { throw "Amounts must be non-negative and covered_months must be greater than zero for '$($row.provider_id)'." }
  $expectedNet = $gross + $tax - $credits
  if ([math]::Abs($expectedNet - $net) -gt 0.01) { throw "Invoice arithmetic does not reconcile for '$($row.provider_id)': gross + tax - credits must equal net." }
  $normalizedMonthly = [math]::Round($net / $coveredMonths, 2)
  $changes += [pscustomobject]@{
    providerId = [string]$row.provider_id
    invoicePeriod = [string]$row.invoice_period
    netInvoiceUsd = [math]::Round($net, 2)
    normalizedMonthlyUsd = $normalizedMonthly
  }
  Set-PropertyValue $entry[0] "actualMonthlyUsd" $normalizedMonthly
  Set-PropertyValue $entry[0] "billingStatus" "invoice-verified"
  Set-PropertyValue $entry[0] "lastVerifiedAt" ([string]$row.verified_at)
  Set-PropertyValue $entry[0] "lastInvoicePeriod" ([string]$row.invoice_period)
  Set-PropertyValue $entry[0] "lastInvoiceNetUsd" ([math]::Round($net, 2))
  Set-PropertyValue $entry[0] "billingCadenceMonths" ([math]::Round($coveredMonths, 2))
  Set-PropertyValue $entry[0] "invoiceEvidence" ([string]$row.evidence_reference)
}

Set-PropertyValue $registry "updatedAt" (Get-Date -Format "yyyy-MM-dd")
$result = [pscustomobject]@{
  registryPath = $registryFile
  invoiceCsvPath = $csvFile
  changeCount = $changes.Count
  changes = $changes
  wrote = $false
}

if ($PSCmdlet.ShouldProcess($registryFile, "Apply invoice-backed subscription costs")) {
  $backup = "$registryFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $registryFile -Destination $backup
  $json = $registry | ConvertTo-Json -Depth 20
  $temporary = Join-Path (Split-Path -Parent $registryFile) ("." + [IO.Path]::GetFileName($registryFile) + "." + [guid]::NewGuid().ToString("N") + ".tmp")
  [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temporary, $registryFile, $true)
  $result.wrote = $true
  $result | Add-Member -NotePropertyName backupPath -NotePropertyValue $backup
}

$result | ConvertTo-Json -Depth 8
