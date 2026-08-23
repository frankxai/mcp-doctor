---
"@frankxai/mcp-doctor": minor
---

Ship as ESM, and put the package on the estate npm release standard: changesets v3, OIDC trusted
publishing with automatic provenance, and a `verify` gate that packs the tarball and asserts what
actually ships.

**Breaking, all three of them.** In 0.x a minor is where breaking goes, but they need saying out loud:

- **`type: module`.** CJS consumers must `import()` rather than `require()`. The source was already
  written ESM-style (`.js` import specifiers under `module: Node16`), so this is a manifest change,
  not a rewrite.
- **`engines.node` 18 → 22.** Node 18 users now get `EBADENGINE`, or a hard failure under
  `engine-strict`. The floor moved to a version that is actually exercised: CI tests on 22, the test
  runner's glob positional postdates 20, and `require(esm)` only landed in 20.19 — claiming 18 or 20
  would be claiming a version nothing here runs.
- **A new `exports` map.** Previously any file in the package was importable; now only the root entry
  and `./package.json` are. If you were reaching into `dist/` directly, that path is closed.

Four defects fixed:

- The version was hand-written in three places and all three had drifted: the CLI banner and the MCP
  handshake said `0.4.0`, and the health-checker introduced itself to other people's servers as
  `0.3.0`, while the package was `0.4.1`. All three now read one `PACKAGE_VERSION` resolved from
  `package.json` at runtime, and tests assert the printed banner and the live handshake — not a
  pattern in a build artifact, which is the check that let this rot in the first place.
- `files` listed a `presets/` directory that does not exist in the repo. It was a dead entry; the
  preset data compiles into `dist/analyzer/presets.js` and always shipped.
- Both `package-lock.json` and `pnpm-lock.yaml` were tracked. Two lockfiles disagree silently.
- `main` was an ESM file with no `exports` map, publint's one complaint.

First tests in this package cover `redactSecrets` — the function that keeps other people's API keys
out of captured stderr — plus `findDuplicates`, the version surfaces above, and an MCP stdio smoke
that asserts `initialize` and `tools/list` return all four tools.
