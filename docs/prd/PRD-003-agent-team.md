# PRD-003 — agent team contract for PRD-001 / PRD-002

- **Status:** active, 2026-11-08
- **Orchestrator:** opencode `opencode-go/deepseek-v4.1-flash`, lane `opencode-7cb2ad7f`
- **Repo:** `repos/mcp-doctor`, branch `agent/opencode/heal-evolve-prd`
- **Machine order:** `pp preflight` reports **1 parallel**, RAM ~2 GB free against a 4 GB dispatch
  requirement. Lanes therefore run **one at a time**. The roster is real; the concurrency is not.

## 1. Roster

| Call sign | Model | Rank | Writes | Cannot do |
|---|---|---|---|---|
| **orchestrator** | `opencode-go/deepseek-v4.1-flash` | planning, PRD, integration, final verification | `docs/prd/**`, `src/cli.ts` | implement a lane it also verifies |
| **implementer** | `opencode-go/glm-5.3-flash` | build | `src/heal/**`, `test/heal*.test.mjs` | edit `score.ts`, `check-server.ts`, or any other lane's paths |
| **researcher** | `opencode-go/hy3` | discovery, read-only | `docs/research/**` | touch `src/` |
| **verifier** | `opencode-go/hy4` | adversarial review | `docs/review/**` | be the same model that wrote the code under review |

Why these three: `glm-5.3-flash` at $0.15/$0.50 per MTok with $0.03 cached reads is the cheapest
capable writer on the plan; `hy3` and `hy4` are different families, which is what makes the verifier
count as a checker rather than a second opinion from the same mouth.

## 2. The one rule that is not negotiable

**Maker ≠ checker.** The verifier must be a different provider family from the implementer. A review
signed by the model that wrote the code is recorded as *missing*, not as done. This estate has four
receipts from 2026-09-19 whose standard line reads "maker ≠ checker NOT satisfied"; that is the
failure this table exists to prevent.

## 3. Lane boundaries

```
src/heal/**              implementer
test/heal*.test.mjs      implementer
src/cli.ts               implementer, `heal` block only (no other command touched)
src/checker/score.ts     frozen for 0.6.0    (criteria change is PRD-002 work)
docs/prd/**              orchestrator
docs/research/**         researcher
docs/review/**           verifier
```

Two writers on one file is the collision this estate keeps rediscovering. `src/cli.ts` has exactly one
owner: the implementer, scoped to the `heal` command. The orchestrator does not touch it. Lane claims
are mechanical:
`node tools/lane.mjs claim --harness <call-sign> --repo repos/mcp-doctor --paths "<glob>" --ttl 2h`.

## 4. Handoffs

1. **orchestrator → implementer:** PRD-001 slice S1, acceptance criteria 1, 2, 3, 8 quoted verbatim. No interpretation required.
2. **implementer → orchestrator:** `npm test` output, the diff stat, and a list of anything in the PRD it could not satisfy.
3. **orchestrator → researcher:** the open question only, never the whole PRD. The researcher answers "what does the current MCP spec say about tool annotations, and which public servers score best on them" with URLs and read dates.
4. **orchestrator → verifier:** the artifact and the criteria, **not** the implementer's reasoning. A verifier that inherits the author's framing stops being a verifier.
5. **verifier → orchestrator:** PASS / FAIL / NEEDS-HUMAN, with the criterion number each verdict rests on.

## 5. Definition of done, for this team

- Every acceptance criterion in the slice is either passing with a quoted assertion, or listed as not met with the reason.
- `npm test` green, and the second run leaves the tree clean.
- No file outside the lane's scope changed (`git status --porcelain` compared before and after).
- No secret value in any receipt, log, or test fixture.
- A receipt at `docs/review/<slice>-<date>.md` signed by the verifier's model id, not by the implementer.

## 6. Escalation

Stop and return to the orchestrator when: a criterion is ambiguous, a repair needs a credential, a
change would cross a lane boundary, or the machine gate drops below 1 parallel. Do not widen scope to
make a test pass. Do not add a dependency without a line in the PRD.
