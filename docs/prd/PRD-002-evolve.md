# PRD-002 — `mcp-doctor evolve`

- **Status:** draft for review, 2026-11-08
- **Owner:** opencode lane `opencode-7cb2ad7f`
- **Target release:** 0.7.0
- **Depends on:** PRD-001 (`heal` supplies the repair verbs this loop calls)

## 1. Problem

The doctor is a snapshot. `score` returns a number, `check` returns a status, `audit` returns a list,
and nothing remembers yesterday. Three consequences, all measured in this estate:

1. **Drift is invisible.** The upstream radar sat 60 days stale before anyone noticed. A score that
   fell from 92 to 61 during a dependency bump would look exactly like a score that was always 61.
2. **The reference bar is internal.** The seven criteria in `score.ts` came from the MCP spec and were
   written once. Servers in the wild have moved; the criteria have not been re-read against a live
   spec revision or against the best-scoring public servers.
3. **Nothing is proactive.** The tool tells you what is wrong *now*, after you ask. The estate's
   failure mode is a green report over a dead surface, and a snapshot tool cannot detect that.

## 2. Outcome

`mcp-doctor` keeps a small, local, append-only history and turns it into advice. It watches the
standard, watches your fleet, and says something before you ask.

```
mcp-doctor evolve snapshot          # append today's scores, one line per server
mcp-doctor evolve trend [--since 30d]
mcp-doctor evolve advise            # ranked actions, each with its evidence
mcp-doctor evolve watch --apply     # refresh the spec + SDK baseline (network, opt-in)
```

## 3. What "cybernetic" means here, concretely

Four loops, each with a sensor, a comparator, and an actuator. A loop without an actuator is a
dashboard, and this estate has enough dashboards.

| Loop | Sensor | Comparator | Actuator |
|---|---|---|---|
| **L1 Fleet drift** | `score` per server, appended to `evolve.jsonl` | previous run, ±10 points | `advise` names the server and the criterion that fell; `heal --plan` for the matching rung |
| **L2 Standard drift** | MCP spec revision, `@modelcontextprotocol/sdk` version | the version `score.ts` criteria were last validated against | a `criteriaVersion` bump task with the spec diff quoted |
| **L3 Reference drift** | the estate's own top-decile servers | the corpus the presets were derived from | regenerated `presets/` when the bar moves by 5 points |
| **L4 Reach drift** | which of a server's tools the estate never calls | call counts from the harness logs | a "dead tool" row: either document it or drop it |

L4 is the one that pays. A server with 38 tools where 6 are used is a context tax on every turn.
The measured case: the shared tool plane exposes 38 tools; the estate's earlier audit found 6
duplicated MCP trees holding 556 MB.

## 4. Storage, and what never gets stored

`evolve.jsonl` under `.mcp-doctor/`, one JSON object per line:
`{ts, server, transport, revision, criteriaVersion, conformance, quality:{percent, criteria:{id:points}}, sdkVersion, specRevision}`.

`revision` and `criteriaVersion` are mandatory from the first line (PRD-004 R5). Without them a trend
line compares two different measurements and reports the change as drift.

Never stored: tool schemas, prompts, arguments, env values, server responses. Counts and scores only.
The file is append-only and safe to commit; it is not a place for anything a secret could reach.

## 5. Non-goals

- No telemetry leaving the machine. `evolve watch` is the only network path and it is opt-in per run.
- No LLM judge in the score path. Scores stay deterministic so a trend means something.
- No new scale. PRD-002 reuses `score`'s seven criteria and adds `criteriaVersion`, not an eighth axis.

## 6. Acceptance criteria

1. `evolve snapshot` twice produces two lines per server and is idempotent within a day (same-day rerun replaces, does not append).
2. `evolve trend` prints a per-server delta; a fixture with a 20-point drop produces one row marked `regression`.
3. `evolve advise` output is ranked by points recoverable, and each row names the criterion, the evidence line from `evolve.jsonl`, and the `heal` rung that would fix it.
4. `evolve watch` exits non-zero with no network available and writes nothing, rather than writing a fabricated baseline.
5. A `criteriaVersion` mismatch produces exactly one advisory, not one per server.
6. `evolve.jsonl` contains no value matching a secret pattern; a test asserts this against a fixture that includes one.
7. Rerunning the whole suite twice leaves the working tree clean (no stray files).

## 7. Slices

| Slice | Scope | Done when |
|---|---|---|
| E1 | snapshot + `evolve.jsonl` | criteria 1, 7 |
| E2 | trend + regression detection | criterion 2 |
| E3 | advise, joined to `heal` rungs | criterion 3 |
| E4 | spec/SDK watch with an explicit offline failure | criteria 4, 5 |
| E5 | presets regeneration from the estate corpus | L3 demoed on two servers |

E1 and E2 are the release. The rest follow only if E1's file proves useful for a week.
