# PRD-001 — `mcp-doctor heal`

- **Status:** draft for review, 2026-11-08
- **Owner:** opencode lane `opencode-7cb2ad7f`, branch `agent/opencode/heal-evolve-prd`
- **Target release:** 0.6.0
- **Supersedes nothing.** Extends `score`, `check`, `audit`, `recommend`.

## 1. Problem, measured

`mcp-doctor` grades and it explains. It does not repair, and the estate proves the gap daily.

From `pp maintain` (2026-11-06) and `claude mcp list` (2026-11-08):

| Observation | Number |
|---|---|
| MCP servers registered in Claude | 60 |
| Connected | 41 |
| Requiring authentication, silently | 19 |
| Locally configured servers | 20 |
| Duplicate registrations (`apify` twice) | 1 confirmed, 6 per pp |
| Dead servers (`gbrain`, `127.0.0.1:7318` ECONNREFUSED) | 1 |
| Tool-schema memory held by those duplicates | 556 MB |

A diagnostic that can name all six and change none of them is a report, not a tool. The estate run
on 2026-11-08 reaped 68 worktrees and pushed 21 branches in an hour because `worktree-gc` had an
`--apply`. `mcp-doctor` has no equivalent, so the MCP layer stays dirty while the doctor keeps
printing the same six findings.

## 2. Outcome

One command that moves a broken MCP configuration to a measurably better one, with a receipt, a
pre-image, and a rollback. Healing is a ladder, not a flag: the cheapest safe repair first, and every
rung states what it will do before it does it.

```
mcp-doctor heal --plan            # list proposed repairs, no writes
mcp-doctor heal --apply           # execute the safe rungs, write receipts
mcp-doctor heal --rollback <id>   # restore the pre-image
```

## 3. The repair ladder

Each rung has a precondition, an effect, and a reversibility class. Rungs below the line require
`--force` or a human.

| Rung | Precondition | Effect | Reversible |
|---|---|---|---|
| **H1 QUARANTINE-DEAD** | server fails `check` 3 consecutive times | comment out its registration, keep the entry in a `quarantined[]` block | yes, one command |
| **H2 DEDUPE** | same `url`+transport under two names | keep the richer entry (auth present, more scopes), disable the other | yes |
| **H3 PIN** | entry uses `latest` or an unpinned `npx pkg` | pin to the resolved version | yes |
| **H4 ENV-REF** | literal secret in an entry | rewrite to `${env:NAME}`, never invent the value | yes |
| —— line: needs an owned source tree —— | | | |
| **H5 ANNOTATE** | server source is in the estate, tool lacks `readOnlyHint`/`destructiveHint` | emit a patch to the tool registration | yes, git |
| **H6 DECORATE** | third-party server scores < 60 on `score` | scaffold a stdio proxy that adds `title`, annotations, bounded `limit` | yes, delete the proxy |

**Not healed, by design:** an unauthenticated connector. The CLI cannot complete an OAuth flow and
must not pretend to. It emits a NEEDS-HUMAN row with the server, the scope it wants, and where to go.
That is the honest ceiling and it matches the measured reality: 19 of 60 connectors need a person.

## 4. Non-goals

- No OAuth automation, no credential storage, no secret values in any output or receipt.
- No silent removal of a server a human registered. Quarantine is a comment plus an index entry.
- No model call inside `heal`. Every repair must be deterministic and reproducible offline. The
  advisory side belongs to PRD-002.

### 4.1 Pre-images are not receipts

A byte-exact pre-image of a config can contain literal env values. It therefore may not be embedded
in a receipt, which is the artifact a user is invited to read and paste. The split is:

| Artifact | Location | Contents | Mode |
|---|---|---|---|
| receipt | `.mcp-doctor/heal/<id>.json` | id, rung, server name, both sha256s, redacted diff, target path | readable, gitignored |
| pre-image | `~/.mcp-doctor/pre-images/<id>.json` | the verbatim bytes, nothing else | `0600`, outside every repo |

A receipt references the pre-image by id and hash. `rollback` reads the pre-image store and verifies
the hash before writing. Deleting the store makes rollback refuse with exit 3; it never falls back to
a partial restore.

### 4.3 The target is named before it is written

`heal` mutates a file a user depends on. It must therefore be impossible to mutate the live profile
by accident, which is exactly what happened on 2026-11-08 when a test harness mis-set the profile
variable and `heal --apply` rewrote the author's real `~/.claude.json`.

- `--config <path>` is a required escape hatch: the tool accepts an explicit path and uses it for
  every scope. A harness that wants isolation sets that flag, not an environment variable.
- The resolved path is printed on the first line of both `--plan` and `--apply` output, above any
  finding, so the operator sees which file is about to change before reading the repairs.
- `--apply` against the **live** profile (the path resolved from the ambient home directory, with no
  `--config`) requires `--yes`. Without it, exit 3 and a one-line message naming the file.
- A receipt records the config path it targeted and the pre-image hash, so a repair is attributable
  to an exact file at an exact byte state.

None of this makes the tool slower to use. It makes the destructive path impossible to reach by
forgetting a flag.

### 4.2 Order of operations

Persist the receipt and the pre-image **before** the config is mutated, atomically (temp file plus
rename). A crash between the write and the receipt leaves a config that no receipt can explain, which
is the one state a user cannot recover from without hand-editing.

`rollback` validates the receipt's recorded target path against the config path this binary resolves
for itself. A receipt is data, not authority: a planted receipt must not be able to redirect a write.

## 5. Acceptance criteria

All must run in `npm test` on Windows and Linux, with no network.

1. Given a fixture config with a dead server, `heal --plan` reports exactly one H1 repair and writes nothing (directory hash unchanged).
2. `heal --apply` on the same fixture changes exactly one entry, writes one receipt under `.mcp-doctor/heal/<id>.json`, and leaves the rest of the file byte-identical.
3. `heal --rollback <id>` restores the config to a byte-identical pre-image (sha256 equality asserted).
4. Given a fixture with `apify` registered twice, H2 keeps the entry with `env` populated and disables the other, and the receipt names which entry it kept and why.
5. Given a fixture with `"command": "npx", "args": ["-y", "some-server@latest"]`, H3 rewrites to a pinned version resolved from the fixture's lockfile, and refuses when no version can be resolved.
6. Given a fixture with an inline `"API_KEY": "sk-..."`, H4 rewrites to `${env:API_KEY}`, never prints the original value, and the receipt's diff redacts it.
7. Given an unauthenticated connector, no rung fires and the output contains one NEEDS-HUMAN row.
8. `heal --apply` twice in a row is idempotent: second run reports zero repairs and writes no receipt.
9. `score` runs before and after under PRD-004's two scales; the receipt records both. A repair that raises `quality` while lowering `conformance` is a failure, not a success, and the receipt says so.
10. Exit codes: 0 clean, 1 repairs available in `--plan`, 2 applied with changes, 3 refused (policy), 4 error.

## 6. Slices

| Slice | Scope | Done when |
|---|---|---|
| S1 | `src/heal/{plan,apply,rollback}.ts` + H1 only | criteria 1, 2, 3, 8 pass |
| S2 | H2, H3 | criteria 4, 5 |
| S3 | H4 with redaction | criterion 6 |
| S4 | NEEDS-HUMAN reporting + exit codes | criteria 7, 10 |
| S5 | H5 owned-source annotation patch | a fixture repo scores +14 after apply |
| S6 | H6 decorator generator | fixture server scores > 60 through the proxy |

S1 through S4 are the release. S5 and S6 are 0.7.0.
