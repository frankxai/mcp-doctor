# Daily observability control plane

`ops/Invoke-DailyObservability.ps1` builds one redacted posture across the MCP,
credential, automation, security-evidence, Railway, token-usage, loop-budget,
and subscription planes.

Railway collection includes current-period provider usage, projected period
cost, resource line items, project/service cost, provider-side limit status,
and policy allocation into overhead, direct workload, optional, experiment,
dormant, or unallocated classes. It does not inspect variables or change
services. Tokscale is collected live for the current month when available;
fresh tokens and cache traffic remain separate and its dollar figure remains
API-equivalent rather than cash spend.

## Authority boundary

The collector is evidence-only. It cannot authorize an agent, grant a tool,
rotate or revoke a credential, change a Railway service, edit an n8n/Make
workflow, or declare API-equivalent pricing to be an invoice. Runtime leases,
provider billing, secrets, and human approvals remain separate authorities.

## Run

```powershell
Copy-Item ops/daily-observability.config.example.json `
  "$HOME/.starlight/observability/daily-observability.config.json"

pwsh ops/Invoke-DailyObservability.ps1 `
  -ConfigPath "$HOME/.starlight/observability/daily-observability.config.json"
```

The default output is:

```text
~/.starlight/observability/daily/latest.json
~/.starlight/observability/daily/latest.md
~/.starlight/observability/daily/latest.sha256
```

JSON is intended for the Starlight Observatory or another local dashboard.
Markdown is the human daily brief. Dated files are immutable run evidence;
`latest.*` is the current projection. The SHA-256 companion detects accidental
or unsophisticated tampering, but it is evidence rather than authenticated
authority; an attacker who can rewrite both files can replace both.

Copy `ops/railway-cost-allocation.example.json` to the private runtime path
configured by `railway.costAllocationPath`, then replace the example projects
and services with owned surfaces. Allocation is policy evidence, not authority
to stop, resize, migrate, or delete a service.

Invoice-backed subscription actuals can be imported from a reviewed CSV:

```powershell
pwsh ops/Import-SubscriptionInvoices.ps1 `
  -RegistryPath "$HOME/.starlight/observability/subscription-registry.json" `
  -CsvPath "$HOME/.starlight/observability/subscription-invoices.csv" `
  -WhatIf
```

Copy `ops/subscription-invoices.example.csv` for the required columns. The
importer normalizes annual or multi-month invoices, validates invoice
arithmetic, accepts USD only, creates a timestamped backup, and writes
atomically. It refuses to invent foreign-exchange rates.

## Schedule on Windows

Run once after reviewing the config:

```powershell
pwsh ops/Install-DailyObservabilityTask.ps1 `
  -ConfigPath "$HOME/.starlight/observability/daily-observability.config.json" `
  -At "08:15"
```

The installer uses a stable PowerShell path, a limited current-user principal,
a 15-minute execution cap, `IgnoreNew` single-flight behavior, and an
idempotent task name. `-WhatIf` previews the mutation. `-RunNow` is optional.
The scheduled task exits zero when collection succeeds; posture remains in the
redacted receipt. Use the collector's `-Strict` switch manually or in CI when
amber/red posture should become a non-zero process exit.

## Severity

- **Red:** leaked-secret evidence, an invalid manifest that may contain values,
  a hard cost/run cap breach, or a Railway volume at the configured critical
  threshold (90% by default).
- **Amber:** registry drift, inline credentials, stale scans/usage, failed guard
  tasks, failed/stopped Railway services, provider health failures, or missing
  invoice-backed costs.
- **Green:** all configured evidence is current and no warning remains.

Green means the observed contracts are satisfied. It does not prove that a
provider account cannot be compromised; provider-side MFA, least privilege,
audit logs, rotation, and billing alerts must still be enabled.

## Daily operator routine

1. Read `latest.md`; handle red findings before normal agent work.
2. Reconcile MCP drift against the canonical registry. Keep write-capable and
   paid tools on demand unless a persistent role is documented.
3. Triage secret-scan and provider-health failures from their private source
   reports; never copy raw findings into public issues or chat.
4. Enter invoice-backed monthly actuals in the private subscription registry.
5. Compare Railway projected cost, overhead share, memory share, and its largest
   services against the configured target. A soft alert is safe; a hard limit is
   approval-gated because Railway takes workloads offline when it is reached.
6. Review n8n/Make workflow execution and spend through dedicated read-only
   adapters before marking those planes covered.
7. Record approval before rotation, revocation, service scaling, workflow
   activation, provider changes, or spend-limit changes.

## Test

```powershell
pwsh test/daily-observability.test.ps1
pwsh test/subscription-invoice-import.test.ps1
```

The fixture verifies registry drift, literal-credential detection without value
disclosure, loop counting, cost-label honesty, and atomic latest receipts.
