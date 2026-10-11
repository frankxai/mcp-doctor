import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateRequest, validateProof, verifyArchive, registryDecision } from "../.github/scripts/release-check.mjs";
const sha = "a".repeat(40);
const manifest = { name: "@frankxai/mcp-doctor", version: "0.5.0", publishConfig: { access: "public" }, repository: { url: "https://github.com/frankxai/mcp-doctor" } };
const request = { ref: "refs/heads/main", sha, expectedSha: sha, version: "0.5.0" };
const bytes = Buffer.from("controlled release bytes");
const expected = { sha, version: "0.5.0", os: "ubuntu-latest", node: "24" };
const proof = { head: sha, package: manifest.name + "@0.5.0", os: "ubuntu-latest", node: "24", tarball: "frankxai-mcp-doctor-0.5.0.tgz", sha256: createHash("sha256").update(bytes).digest("hex"), integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"), entries: ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/cli.js", "dist/mcp-server.js"] };
test("release source must be the explicitly requested accepted main", () => {
  assert.equal(validateRequest(request, manifest).head, sha);
  for (const patch of [{ ref: "refs/heads/feature" }, { expectedSha: "b".repeat(40) }, { sha: "abc" }, { version: "0.5.0; echo bad" }, { version: "0.5.0-next.1" }]) assert.throws(() => validateRequest({ ...request, ...patch }, manifest));
});
test("release identity, public access and repository cannot be substituted", () => {
  for (const patch of [{ name: "@other/package" }, { version: "0.6.0" }, { private: true }, { publishConfig: { access: "restricted" } }, { repository: { url: "https://github.com/other/repo" } }]) assert.throws(() => validateRequest(request, { ...manifest, ...patch }));
});
test("tested archive hashes and producer matrix must match exactly", () => {
  assert.equal(validateProof(proof, bytes, expected).integrity, proof.integrity);
  assert.throws(() => validateProof(proof, Buffer.from("changed release bytes"), expected));
  for (const patch of [{ head: "b".repeat(40) }, { package: "@other/package@0.5.0" }, { sha256: "wrong" }, { integrity: "sha512-wrong" }, { os: "windows-latest" }, { node: "18" }, { tarball: "../../archive.tgz" }]) assert.throws(() => validateProof({ ...proof, ...patch }, bytes, expected));
});
test("recorded private, traversal, malformed or duplicate paths are refused", () => {
  for (const entry of ["dist/../private/state", "dist/.env", "dist/.env.local", "dist/.npmrc", "dist/secrets/config", "dist/node_modules/token", "dist/private/vault.json", "dist//index.js", "/dist/index.js", "dist/file\nother", "package.json"]) assert.throws(() => validateProof({ ...proof, entries: [...proof.entries, entry] }, bytes, expected));
});
test("package must contain its actual required binary, API and license entries", () => {
  for (const missing of ["package.json", "LICENSE", "dist/index.js", "dist/cli.js", "dist/mcp-server.js"]) assert.throws(() => validateProof({ ...proof, entries: proof.entries.filter((entry) => entry !== missing) }, bytes, expected));
});
test("only an actual registry 404 establishes an absent version", () => {
  assert.deepEqual(registryDecision(404, null, { name: manifest.name, version: manifest.version, integrity: proof.integrity }), { state: "missing" });
  for (const status of [0, 401, 403, 429, 500]) assert.throws(() => registryDecision(status, null, {}));
});
test("a published matching version is recoverable, a collision is refused", () => {
  const metadata = { name: manifest.name, version: manifest.version, dist: { integrity: proof.integrity } };
  const expected = { name: manifest.name, version: manifest.version, integrity: proof.integrity };
  assert.deepEqual(registryDecision(200, metadata, expected), { state: "matching" });
  assert.throws(() => registryDecision(200, { ...metadata, dist: { integrity: "sha512-other" } }, expected));
});

function archiveFixture(version = "0.5.0") {
  const directory = mkdtempSync(path.join(tmpdir(), "mcp-release-fixture-"));
  const members = ["package.json", "LICENSE", "dist/index.js", "dist/cli.js", "dist/mcp-server.js"];
  mkdirSync(path.join(directory, "package", "dist"), { recursive: true });
  for (const name of members) writeFileSync(path.join(directory, "package", name), name === "package.json" ? JSON.stringify({ ...manifest, version }) : "controlled fixture");
  const filename = path.join(directory, proof.tarball);
  const packed = spawnSync("tar", ["-czf", filename, "-C", directory, ...members.map((name) => "package/" + name)], { encoding: "utf8", shell: false, timeout: 10000 });
  assert.equal(packed.error, undefined);
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(filename);
  const actual = { ...proof, entries: members, sha256: createHash("sha256").update(bytes).digest("hex"), integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") };
  writeFileSync(path.join(directory, "installed-audit-proof.json"), JSON.stringify(actual));
  return { directory, filename, actual };
}
test("the actual tar reader validates complete regular-file archive contents", () => {
  const fixture = archiveFixture();
  assert.equal(verifyArchive(fixture.directory, expected).integrity, fixture.actual.integrity);
  writeFileSync(path.join(fixture.directory, "installed-audit-proof.json"), JSON.stringify({ ...fixture.actual, entries: [...fixture.actual.entries, "presets/forged.json"] }));
  assert.throws(() => verifyArchive(fixture.directory, expected));
});
test("valid archive hashes cannot disguise a different manifest version", () => {
  const fixture = archiveFixture("0.6.0");
  assert.throws(() => verifyArchive(fixture.directory, expected));
});
