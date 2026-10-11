import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const PACKAGE = "@frankxai/mcp-doctor";
const REPOSITORY = "https://github.com/frankxai/mcp-doctor";
const HEAD = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ALLOWED = /^(dist\/[A-Za-z0-9_./-]+|presets\/[A-Za-z0-9_./-]+|README\.md|LICENSE|package\.json)$/;
const REQUIRED = ["package.json", "LICENSE", "dist/index.js", "dist/cli.js", "dist/mcp-server.js"];
const digest = (algorithm, bytes, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
function plainFile(file) {
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024, "Release input must be a bounded regular file");
  return readFileSync(file);
}
export function validateRequest(request, manifest) {
  assert.equal(request.ref, "refs/heads/main", "Release input must be accepted main");
  assert.ok(HEAD.test(request.sha) && HEAD.test(request.expectedSha), "Full source SHAs required");
  assert.equal(request.sha, request.expectedSha, "Main moved from the requested source");
  assert.ok(VERSION.test(request.version), "Stable semver required");
  assert.equal(manifest.name, PACKAGE);
  assert.equal(manifest.version, request.version);
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.repository?.url?.replace(/\.git$/, ""), REPOSITORY);
  return { name: PACKAGE, version: manifest.version, head: request.sha };
}
export function validateProof(proof, bytes, expected) {
  assert.ok(HEAD.test(expected.sha));
  assert.equal(proof.head, expected.sha, "Artifact comes from different source");
  assert.equal(proof.package, PACKAGE + "@" + expected.version);
  assert.equal(proof.os, expected.os);
  assert.equal(String(proof.node), String(expected.node));
  assert.equal(proof.tarball, "frankxai-mcp-doctor-" + expected.version + ".tgz");
  assert.ok(/^frankxai-mcp-doctor-\d+\.\d+\.\d+\.tgz$/.test(proof.tarball));
  assert.equal(proof.sha256, digest("sha256", bytes), "Archive bytes changed");
  assert.equal(proof.integrity, "sha512-" + digest("sha512", bytes, "base64"), "Archive integrity changed");
  assert.ok(Array.isArray(proof.entries) && proof.entries.length > 0 && proof.entries.length <= 1000);
  assert.equal(new Set(proof.entries).size, proof.entries.length, "Duplicate archive entries");
  for (const entry of proof.entries) {
    assert.ok(typeof entry === "string" && entry.length <= 300 && ALLOWED.test(entry), "Unexpected packaged path");
    assert.ok(!entry.split("/").some((part) => !part || part.startsWith(".") || ["private", "vaults", "memory", "credentials", "secrets", "node_modules"].includes(part.toLowerCase())), "Private or unsafe archive path");
  }
  for (const entry of REQUIRED) assert.ok(proof.entries.includes(entry), "Missing required package entry");
  return { name: PACKAGE, version: expected.version, head: expected.sha, integrity: proof.integrity, sha256: proof.sha256 };
}
function tar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8", shell: false, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined, "Archive inspection failed");
  assert.equal(result.status, 0, "Archive inspection failed");
  return result.stdout.trim().split(/\r?\n/);
}
export function verifyArchive(directory, expected) {
  const proof = JSON.parse(plainFile(path.join(directory, "installed-audit-proof.json")).toString("utf8").replace(/^\uFEFF/, ""));
  const candidates = readdirSync(directory).filter((name) => name.endsWith(".tgz"));
  assert.equal(candidates.length, 1, "Exactly one tested archive required");
  assert.equal(candidates[0], proof.tarball);
  const archive = path.resolve(directory, candidates[0]);
  const summary = validateProof(proof, plainFile(archive), expected);
  const actualEntries = tar(["-tzf", archive]).map((name) => {
    assert.ok(name.startsWith("package/"), "Unexpected tar root");
    return name.slice(8);
  });
  assert.deepEqual(actualEntries.slice().sort(), proof.entries.slice().sort(), "Recorded entries differ from actual archive");
  assert.ok(tar(["-tvzf", archive]).every((line) => line.startsWith("-")), "Archive may contain links or non-files");
  const manifest = JSON.parse(tar(["-xOzf", archive, "package/package.json"]).join("\n"));
  validateRequest({ ref: "refs/heads/main", sha: expected.sha, expectedSha: expected.sha, version: expected.version }, manifest);
  return { ...summary, archive };
}
export function registryDecision(status, metadata, expected) {
  if (status === 404) return { state: "missing" };
  assert.equal(status, 200, "Registry could not establish version state");
  assert.equal(metadata?.name, expected.name);
  assert.equal(metadata?.version, expected.version);
  assert.equal(metadata?.dist?.integrity, expected.integrity, "Published version contains different bytes");
  return { state: "matching" };
}
async function readVersion(name, version) {
  const response = await fetch("https://registry.npmjs.org/" + encodeURIComponent(name) + "/" + encodeURIComponent(version), { signal: AbortSignal.timeout(15000) });
  if (response.status !== 200) return { status: response.status, metadata: null };
  const reader = response.body.getReader();
  const parts = [];
  let count = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    count += part.value.length;
    if (count > 1024 * 1024) { await reader.cancel(); throw new Error("Registry response exceeds release budget"); }
    parts.push(Buffer.from(part.value));
  }
  return { status: response.status, metadata: JSON.parse(Buffer.concat(parts).toString("utf8")) };
}
async function main() {
  const expected = { sha: process.env.RELEASE_SHA, version: process.env.RELEASE_VERSION, os: process.env.RELEASE_OS ?? "ubuntu-latest", node: process.env.RELEASE_NODE ?? "24" };
  const operation = process.argv[2];
  if (operation === "source") {
    const manifest = JSON.parse(plainFile("package.json"));
    console.log(JSON.stringify(validateRequest({ ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, expectedSha: expected.sha, version: expected.version }, manifest)));
    return;
  }
  const proof = verifyArchive(process.argv[3] ?? ".", expected);
  if (operation === "artifact") { console.log(JSON.stringify(proof)); return; }
  assert.equal(operation, "registry", "Unknown release operation");
  const response = await readVersion(proof.name, proof.version);
  const decision = registryDecision(response.status, response.metadata, proof);
  const receipt = { ...proof, ...decision, observedAt: new Date().toISOString() };
  writeFileSync("registry-release-state.json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Release verification failed; no registry operation authorized by this check"); process.exitCode = 1; });
}
