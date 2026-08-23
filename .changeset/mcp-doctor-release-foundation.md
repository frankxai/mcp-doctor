---
"@frankxai/mcp-doctor": minor
---

Ship as ESM, and put the package on the estate npm release standard: changesets v3, OIDC trusted
publishing with automatic provenance, and a `verify` gate that packs the tarball and asserts what
actually ships.

The `type: module` flip is why this is a minor rather than a patch — in 0.x that is the breaking
signal. The source was already written ESM-style (`.js` import specifiers under `module: Node16`),
so the change is the manifest, not the code. `main` is now backed by an `exports` map with `types`
first, which is what publint asks for.

Three defects fixed along the way:

- `files` listed a `presets/` directory that does not exist in the repo, so the published tarball
  silently omitted whatever it was supposed to carry.
- The MCP handshake advertised a hardcoded `0.4.0` while the package was `0.4.1`. It now reads the
  version from `package.json`, and a test fails if a literal is ever put back.
- Both `package-lock.json` and `pnpm-lock.yaml` were tracked. Two lockfiles disagree silently; pnpm
  is the estate package manager, so the npm one is gone.

First tests in this package: `redactSecrets` (the function that keeps other people's API keys out of
captured stderr) and `findDuplicates`, plus an MCP stdio smoke that asserts the server answers
`initialize` and `tools/list` with all four tools.
