# Harness — mcp-doctor

**Profile:** A — MCP Server (also ships a CLI: `audit` / `recommend` / `agents`)
**Stack installed:** L1 ☑ (CI ready) · L2 ☑ (MCP gauntlet) · L3 ☐ · L4 ☐ · L5 ☐
**Last verified:** 2026-06-03 (v0.4.0)

## Claimed vs verified

| Claim | Reality (verified) | Verdict |
|---|---|---|
| README: "Exposes 4 tools: `audit`, `detect_agents`, `find_misplaced`, `recommend`" | `tools/list` returns **exactly these 4 tools**, each with valid `inputSchema` + description | ✅ Accurate — no drift |
| Works as an MCP server (`serve`) | Boots over stdio, completes `initialize` handshake (protocol 2024-11-05, serverInfo `mcp-doctor` v0.4.0) | ✅ Verified |
| Works as a CLI | `node dist/cli.js --help` / `audit --quick` / `recommend` / `agents` all run | ✅ Verified |
| Builds from source | `pnpm run build` (`tsc`) reproduces `dist/` clean, exit 0; gauntlet still 12/12 on fresh build | ✅ Reproducible |

**This repo's claims match its code. No corrections needed.**

## Verified behavior (MCP gauntlet, 12/12)

`test/mcp-gauntlet.mjs` spawns `node dist/cli.js serve` and drives the real MCP protocol:

- `initialize` → correct `protocolVersion` + `serverInfo`.
- `tools/list` → 4 tools, count matches implementation, each has schema + description.
- **Per-tool minimal valid call** (`tools/call` with `{}`/defaults) → all 4 return non-empty
  structured `content[].text`, none error: audit (272 chars), detect_agents (128),
  find_misplaced (73), recommend (1297).
- Unknown tool → JSON-RPC error `-32601` (proper error handling).

**≥90% of exposed tools return valid results to a minimal valid call: 4/4 = 100%.**

## Run it

```bash
git clone https://github.com/frankxai/mcp-doctor.git
cd mcp-doctor && pnpm install && pnpm run build
node test/mcp-gauntlet.mjs      # 12 assertions, exit 0
# or use it for real:
node dist/cli.js audit --quick
```

## CI

`.github/workflows/harness.yml` ready (build → gauntlet on ubuntu). **Not committed** — token
lacks `workflow` scope (`gh auth refresh -s workflow` then commit). See ecosystem `BLOCKERS.md`.

## Golden dataset

N/A — deterministic protocol/contract test. The gauntlet is the regression spine.

## Demo today

**Yes** — `node test/mcp-gauntlet.mjs` (12/12) or `node dist/cli.js audit` against a live Claude config.

## Status: **SELLABLE**

Real MCP server + CLI, accurate README, reproducible build, contract-tested. The reference
example of what "proven" looks like in this ecosystem. L4 red-team (tool-arg injection / path
traversal on the config-reading tools) is the recommended next layer.
