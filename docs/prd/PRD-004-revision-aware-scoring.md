# PRD-004 — grade against a revision, not an opinion

- **Status:** draft for review, 2026-11-08
- **Owner:** opencode lane `opencode-7cb2ad7f`
- **Target release:** 0.6.0 (ships with PRD-001)
- **Evidence:** `docs/research/mcp-tool-quality-2026-11-08.md`, plus primary sources re-checked by the
  orchestrator on 2026-11-08

## 1. What the research found, verified

The spec at `modelcontextprotocol.io` advertises revision **`2026-07-28`**, and its schema declares
`LATEST_PROTOCOL_VERSION = "2026-07-28"` with a stateless core: no `initialize`, no `Mcp-Session-Id`,
required `resultType` on every result, `server/discover`, and `CacheableResult` carrying
`ttlMs` + `cacheScope`.

The published TypeScript SDK does not speak that yet. `npm view @modelcontextprotocol/sdk dist-tags`
returns a single tag, `latest: 1.32.2`. Installed and inspected on 2026-11-08, its types declare:

```
export declare const LATEST_PROTOCOL_VERSION = "2025-11-25";   // stable surface
export declare const LATEST_PROTOCOL_VERSION = "DRAFT-2026-v1"; // draft surface
```

Neither `server/discover` nor the `resultType` field appears in the SDK's type declarations.

So the estate is mid-transition, and `mcp-doctor` sits on the wrong side of it in two ways:

1. **It grades servers against seven criteria that no revision requires.** All seven are
   stricter-than-spec: annotations, titles and `outputSchema` are optional; there is no minimum
   description length; `inputSchema` bounding is not mandated; server-name prefixing is only
   *recommended* for aggregators; and pagination is protocol-level (`tools/list` with an opaque
   cursor and a server-chosen page size), not a `limit` parameter on domain tools.
2. **It speaks 2025-11-25 while the spec advertises 2026-07-28**, and it does not say so anywhere in
   its output.

A score that mixes "the protocol requires this" with "we think this is better" is unfalsifiable. A
user cannot tell whether 61 means *non-conformant* or *conformant but not to our taste*.

## 2. Outcome

Every report carries the revision it was graded against and splits the result into two scales.

```
mcp-doctor score -- <cmd>
  conformance  2026-07-28   PASS / FAIL   (spec-required only, binary, per revision)
  quality      100/100      estate bar    (this repo's stricter contract, explicitly labelled)
  advisory     n            forward-looking signals for revisions we do not yet speak
```

## 3. Rules

- **R1 — Two scales, never blended.** `conformance` is binary and only contains what the target
  revision makes MUST/SHOULD. `quality` keeps the current seven criteria, labelled
  `estate-contract`, with a one-line note that they exceed the spec.
- **R2 — Revision is an input, not an assumption.** `--revision 2025-11-25|2026-07-28|auto`. `auto`
  reads `server/discover` when available and falls back to the SDK's negotiated version. The chosen
  revision is printed in the header of every report.
- **R3 — Forward features are advisories.** A server missing `resultType`, `ttlMs`/`cacheScope`,
  deterministic `tools/list` ordering, or `server/discover` under a *draft* target produces an
  advisory row. It never lowers `conformance` for a revision the server was not asked to speak.
- **R4 — The doctor grades itself.** `mcp-doctor serve` is scored in CI on every build. A surface
  below the estate floor fails the build. The README's "scores 100% on `mcp-doctor score`" claim
  becomes a test, not a sentence.
- **R5 — `criteriaVersion` is stored with every score.** When the criteria change, old scores do not
  silently compare against new ones.
- **R6 — No claim of compliance in prose.** README and CLI text say "estate quality contract" where
  they currently imply spec conformance, unless the conformance scale actually passes.

## 4. Non-goals

- No attempt to make the SDK speak 2026-07-28. That is upstream's job; this PRD only stops the
  doctor from pretending.
- No new dependency and no network call in the score path.
- No change to the seven quality criteria themselves in this release. Reweighting them is a separate
  decision with its own evidence.

## 5. Acceptance criteria

1. `score --json` emits `{ revision, conformance: {pass, failures[]}, quality: {percent, criteria[]}, advisory: [] }`.
2. A fixture server that sets nothing but valid `inputSchema` scores `conformance: pass` under `2025-11-25` and `quality: 0`.
3. A fixture missing `outputSchema` produces a `quality` failure and **no** `conformance` failure.
4. A fixture missing `resultType` under `--revision 2026-07-28` produces one advisory; the same fixture under `2025-11-25` produces none.
5. `--revision auto` against a fixture without `server/discover` falls back and prints the fallback revision in the header, not a guess.
6. The header of every human-readable report names both the revision and the criteriaVersion.
7. `npm test` includes a self-conformance test that runs `mcp-doctor score` against `dist/mcp-server.js` and fails below the estate floor.
8. No secret, no network, no new dependency.
9. README contains no sentence claiming spec compliance that the conformance scale would fail. A grep test enforces the wording.

## 6. Slices

| Slice | Scope | Done when |
|---|---|---|
| C1 | report shape + revision header | criteria 1, 6 |
| C2 | conformance vs quality split | criteria 2, 3 |
| C3 | advisory channel | criterion 4, 5 |
| C4 | self-conformance in CI + README honesty | criteria 7, 9 |

C1 and C2 are the release. C3 and C4 follow in the same minor if the fixture work stays under a day.

## 7. Why this precedes `heal`

`heal` acts on what `score` says. Healing to raise a number that measures the wrong thing is worse
than doing nothing: it produces a server that is optimised for a private bar while the user believes
it is conformant. PRD-001's H6 (decorate below 60) is exactly that risk. The score must be honest
before anything is allowed to optimise against it.
