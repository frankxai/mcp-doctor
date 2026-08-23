import { readFileSync } from "node:fs";

/**
 * The one place this package learns its own version.
 *
 * Before this existed the version was written out by hand in three places and all three had drifted:
 * the CLI banner said 0.4.0, the MCP handshake said 0.4.0, and the health-checker introduced itself
 * to other servers as 0.3.0 — while the package was 0.4.1. Nothing failed, because nothing compares
 * a banner to a manifest.
 *
 * Resolved from `package.json` at runtime rather than injected at build time so it stays correct
 * however the package is consumed: `npx`, a nested `node_modules` install, or a local `dist/` run.
 * npm always includes `package.json` in the tarball, so this cannot fail to resolve.
 */
export const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;
