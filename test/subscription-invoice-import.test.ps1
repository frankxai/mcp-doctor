$ErrorActionPreference = "Stop"
$root = Join-Path ([IO.Path]::GetTempPath()) ("mcp-doctor-invoices-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $root | Out-Null
try {
  $registry = Join-Path $root "registry.json"
  $csv = Join-Path $root "invoices.csv"
  @{
    schema = "starlight.subscriptionRegistry.v1"
    updatedAt = "2026-01-01"
    containsSecretValues = $false
    entries = @(@{ id = "annual-tool"; billingStatus = "unknown"; actualMonthlyUsd = $null })
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $registry -Encoding utf8
  @"
provider_id,invoice_period,gross_amount_usd,tax_usd,credits_usd,net_amount_usd,covered_months,currency,verified_at,evidence_reference
annual-tool,2026-08,240.00,0.00,0.00,240.00,12,USD,2026-08-15,private/invoice.pdf
"@ | Set-Content -LiteralPath $csv -Encoding utf8

  $script = Join-Path (Split-Path -Parent $PSScriptRoot) "ops/Import-SubscriptionInvoices.ps1"
  & $script -RegistryPath $registry -CsvPath $csv -WhatIf | Out-Null
  $before = Get-Content -Raw -LiteralPath $registry | ConvertFrom-Json
  if ($null -ne $before.entries[0].actualMonthlyUsd) { throw "WhatIf modified the registry" }

  $result = & $script -RegistryPath $registry -CsvPath $csv | ConvertFrom-Json
  $after = Get-Content -Raw -LiteralPath $registry | ConvertFrom-Json
  if ($result.wrote -ne $true) { throw "Importer did not report a write" }
  if ([double]$after.entries[0].actualMonthlyUsd -ne 20.00) { throw "Annual invoice was not normalized to monthly cost" }
  if ($after.entries[0].billingStatus -ne "invoice-verified") { throw "Billing status was not updated" }
  if (-not (Get-ChildItem -LiteralPath $root -Filter "registry.json.bak-*")) { throw "Backup was not created" }

  (Get-Content -Raw -LiteralPath $csv).Replace(",USD,", ",EUR,") | Set-Content -LiteralPath $csv -Encoding utf8
  $currencyRejected = $false
  try { & $script -RegistryPath $registry -CsvPath $csv 2>$null | Out-Null } catch { $currencyRejected = $true }
  if (-not $currencyRejected) { throw "Unsupported currency should fail" }
  Write-Host "subscription-invoice-import.test.ps1: PASS"
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
