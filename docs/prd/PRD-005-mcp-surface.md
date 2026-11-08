# PRD-005 — heal as a callable surface, not a CLI-only verb

- **Status:** draft, 2026-11-08
- **Owner:** opencode lane, branch `agent/opencode/heal-evolve-prd`
- **Target release:** 0.6.0, ships with PRD-001
- **Depends on:** PRD-001 (the rungs), PRD-004 (revision-aware scoring)

## 1. Problem

`mcp-doctor` has two surfaces. The CLI has `audit`, `recommend`, `score`, `check`, `serve` and now
`heal`. The MCP server, which is what an agent actually talks to, exposes four tools:
`mcp_doctor_audit`, `mcp_doctor_agents`, `mcp_doctor_misplaced_configs`, `mcp_doctor_preset_packs`.

So the one verb that changes anything is reachable only by a human at a shell. An agent that finds a
dead server through `mcp_doctor_audit` cannot repair it, and a harness cannot switch the doctor from
diagnose to repair without shelling out. The tool advertises itself as an MCP server and hides its
only actuator behind a terminal.

## 2. Outcome

Three MCP tools, mirroring the CLI exactly, plus one that reports which mode the doctor is in.

| Tool | Maps to | Writes |
|---|---|---|
| `mcp_doctor_heal_plan` | `heal --plan` | nothing |
| `mcp_doctor_heal_apply` | `heal --apply --config <path> --yes` | the named config only |
| `mcp_doctor_heal_rollback` | `heal --rollback <id> --config <path>` | the named config only |
| `mcp_doctor_modes` | — | nothing; returns the available verbs and their write class |

`mcp_doctor_modes` is the "switch between options" surface: it returns the list an agent reads to
decide whether it is allowed to act, not just report.

## 3. Rules that keep the MCP surface honest

- **Explicit target, always.** `heal_apply` requires `configPath` in its input schema. There is no
  default, and the tool does not read the ambient profile. MCP callers are not terminal users.
- **Plan before apply is not enforced by the tool, but the response says so.** `heal_apply` returns
  the plan it executed alongside the result, so a caller that skipped planning still sees what moved.
- **Structured output on every tool.** The repo already scores 100% on its own `score` command; a new
  tool that returns prose would break that, and PRD-004 R4 makes the self-score a CI gate.
- **No tool performs a rollback by id alone.** The config path is required, because a receipt is data
  and PRD-001 §4.2 already says it must not be able to redirect a write.
- **Annotations are declared.** `heal_plan` and `modes` are `readOnlyHint: true`. `heal_apply` and
  `heal_rollback` declare `destructiveHint: true, idempotentHint: true`.

## 4. Acceptance criteria

1. `mcp_doctor_heal_plan` on a fixture config returns the same repair list as `heal --plan --config`, in structured output, and writes nothing.
2. `mcp_doctor_heal_apply` without `configPath` fails validation rather than falling back to the ambient profile.
3. `mcp_doctor_heal_apply` with a `configPath` applies and returns `{applied, receiptIds, preImagePath, plan}`.
4. `mcp_doctor_heal_rollback` with a receipt id and a mismatched `configPath` refuses and writes nothing.
5. `mcp_doctor_modes` returns every verb with its write class, derived from the same table the CLI uses, so the two cannot drift.
6. `mcp-doctor score` against the server's own tool list stays at 100% after the new tools land (PRD-004 R4).
7. All four tools carry `readOnlyHint` or `destructiveHint` as declared in §3.

## 5. Non-goals

- No new transport. The existing stdio server is the surface.
- No auto-heal on audit. A read tool must never mutate, even when it is certain.
- No scheduling. That is PRD-002's loop, and it stays out of the server.

## 6. Slice

One slice. If it cannot be done in a single sitting, the tool table in §2 is wrong and this PRD
should be re-cut rather than partially landed.
