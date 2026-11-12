// S1 acceptance: H1 QUARANTINE-DEAD (PRD-001-heal criteria 1, 2, 3, 8) plus the
// review fixes: persisted failure history (A), receipts that carry no pre-image
// and no secret (B), byte-surgery edge cases (C), artifact-first ordering and
// receipt path validation (D). All exercised end-to-end through the CLI.
//
// The history store is seeded directly here so each acceptance test states its
// own precondition; test/heal-s2.test.mjs proves the recording path itself with
// real `audit` invocations.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const cli = path.join(root, "dist", "cli.js");
const fixture = path.join(here, "fixtures", "health-probe.mjs");

const LAST_FAILURE = "2026-11-01T00:00:00.000Z";
const REASON = `MCP check failed (missing-command) on 3 consecutive audit runs; last failure ${LAST_FAILURE}`;
const DEAD_COMMAND = "mcp-doctor-h1-fixture-missing-binary";
const SECRET = "sk-0000000000000000000000test";

const healthyConfig = { type: "stdio", command: process.execPath, args: [fixture, "success"] };
const deadConfig = { type: "stdio", command: DEAD_COMMAND };
const placeholderEnvConfig = { type: "stdio", command: process.execPath, args: [fixture, "success"], env: { TOKEN: "YOUR_TOKEN" } };

const healthyText = JSON.stringify(healthyConfig);
const deadText = JSON.stringify(deadConfig);
const placeholderText = JSON.stringify(placeholderEnvConfig);
const preText = `{"mcpServers":{"healthy":${healthyText},"dead":${deadText},"placeholder-env":${placeholderText}}}`;
const quarantineEntry = `{"name":"dead","config":${deadText},"reason":${JSON.stringify(REASON)}}`;
const expectedPostText = `{"quarantined":[${quarantineEntry}],"mcpServers":{"healthy":${healthyText},"placeholder-env":${placeholderText}}}`;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const strip = (text) => (text ?? "").replace(/\x1b\[[0-9;]*m/g, "");

function envFor(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData"),
    LOCALAPPDATA: path.join(home, "LocalAppData"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    MCP_DOCTOR_HEAL_MIN_INTERVAL_MS: "0",
  };
}

/** Write a durable history record exactly as the audit path would. */
function seedFailure(home, name, rawValue, { count = 3, scope = "user", projectPath, configPath, status = "missing-command" } = {}) {
  const target = configPath ?? path.join(home, ".claude.json");
  const identity = `${target}\u0000${scope}\u0000${projectPath ?? ""}\u0000${name}`;
  const storePath = path.join(home, ".mcp-doctor", "failure-history.json");
  mkdirSync(path.dirname(storePath), { recursive: true });
  const store = existsSync(storePath)
    ? JSON.parse(readFileSync(storePath, "utf8"))
    : { version: 1, records: {} };
  store.records[identity] = {
    server: name,
    scope,
    ...(projectPath !== undefined ? { projectPath } : {}),
    configPath: target,
    configHash: sha256(rawValue),
    consecutiveFailures: count,
    firstFailureAt: "2026-10-31T00:00:00.000Z",
    lastFailureAt: LAST_FAILURE,
    lastStatus: status,
    run: "seed",
  };
  writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
}

function makeHome({ seed = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "mcp-doctor-heal-"));
  writeFileSync(path.join(home, ".claude.json"), preText, "utf8");
  if (seed) seedFailure(home, "dead", deadText);
  return home;
}

function runHeal(home, args, { ambient = false } = {}) {
  // By default --apply calls are scoped to the temp fixture via --config, so
  // they never reach the §4.3 live-profile rail. Tests that deliberately
  // exercise the ambient (rail) behaviour pass { ambient: true } and no
  // --config, isolating everything to the temp home through the env below.
  const final = [...args];
  if (!ambient && final.includes("--apply") && !final.includes("--config")) {
    final.splice(final.indexOf("--apply") + 1, 0, "--config", path.join(home, ".claude.json"));
  }
  const result = spawnSync(process.execPath, [cli, "heal", ...final], { env: envFor(home), cwd: home, encoding: "utf8", timeout: 45000 });
  return { ...result, out: strip(result.stdout), err: strip(result.stderr) };
}

function dirFingerprints(dir) {
  const out = {};
  const walk = (base, rel) => {
    for (const name of readdirSync(base)) {
      const full = path.join(base, name);
      const nextRel = rel ? rel + "/" + name : name;
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full, nextRel);
      else out[nextRel] = sha256(readFileSync(full, "utf8"));
    }
  };
  walk(dir, "");
  return out;
}

function healReceipts(home) {
  const dir = path.join(home, ".mcp-doctor", "heal");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
}

function configText(home) {
  return readFileSync(path.join(home, ".claude.json"), "utf8");
}

const expectedReceiptId = `h1-dead-${createHash("sha256").update(`H1\u0000dead\u0000${preText}`, "utf8").digest("hex").slice(0, 16)}`;
const limit = { timeout: 45000 };

test("heal --plan reports exactly one H1 repair and writes nothing (criterion 1)", limit, () => {
  const home = makeHome();
  const before = dirFingerprints(home);
  const result = runHeal(home, ["--plan"]);
  assert.equal(result.status, 1, result.stderr || result.out);
  const h1Lines = result.out.match(/H1 QUARANTINE-DEAD/g) ?? [];
  assert.equal(h1Lines.length, 1, "plan must propose exactly one H1 repair");
  assert.ok(result.out.includes("dead "), result.out);
  assert.ok(result.out.includes(REASON), "the plan states the recorded-death reason");
  const after = dirFingerprints(home);
  assert.equal(JSON.stringify(before), JSON.stringify(after), "plan must not write a single byte");
});

test("heal --apply changes exactly one entry, writes one receipt, leaves the rest byte-identical (criterion 2)", limit, () => {
  const home = makeHome();
  const result = runHeal(home, ["--apply"]);
  assert.equal(result.status, 2, result.stderr || result.out);
  assert.deepEqual(healReceipts(home), [`${expectedReceiptId}.json`], "exactly one receipt");
  assert.equal(configText(home), expectedPostText, "surviving entries byte-identical; dead entry moved verbatim into quarantined[]");

  const receipt = JSON.parse(readFileSync(path.join(home, ".mcp-doctor", "heal", `${expectedReceiptId}.json`), "utf8"));
  assert.equal(receipt.rung, "H1");
  assert.equal(receipt.server, "dead");
  assert.equal(receipt.preImageSha256, sha256(preText));
  assert.equal(receipt.postImageSha256, sha256(expectedPostText));
  assert.ok(!/"preImage"/.test(JSON.stringify(receipt)), "§4.1: receipts never carry a preImage");
  assert.ok(!/"preImagePath"/.test(JSON.stringify(receipt)), "§4.1: no external pre-image artifact is referenced");
  assert.ok(Array.isArray(receipt.diff?.removedEntries) && receipt.diff.removedEntries.length === 1, "receipt carries a structural summary");
  assert.ok(Array.isArray(receipt.diff?.quarantinedEntries) && receipt.diff.quarantinedEntries.length === 1, "receipt carries a structural summary");
  // Finding 1: the summary says which server moved and which settings it had,
  // and carries no value at all.
  const removed = receipt.diff.removedEntries[0];
  assert.equal(removed.server, "dead", "the receipt names which server moved");
  assert.deepEqual(removed.keys, ["type", "command"], "the receipt names the entry's keys");
  assert.deepEqual(removed.values.map((v) => v.path).sort(), [".", "command", "type"], "one reference per value, root included");
  assert.ok(removed.values.every((v) => /^[a-f0-9]{64}$/.test(v.sha256)), "every value is a sha256 reference");
  assert.ok(!JSON.stringify(receipt).includes(DEAD_COMMAND), "no config value reaches the receipt");
  assert.ok(!JSON.stringify(receipt).includes(deadText), "no raw entry text reaches the receipt");
  assert.equal(receipt.reconstruction?.version, 1, "receipt carries the reconstruction record");
  assert.equal(receipt.reconstruction.removals.length, 1);
  assert.equal(receipt.reconstruction.removals[0].holes[0].name, "dead");
  assert.ok(!existsSync(path.join(home, ".mcp-doctor", "pre-images")), "no pre-image store is written at all");
});

test("heal --apply twice is idempotent: no repairs, no new receipt (criterion 8)", limit, () => {
  const home = makeHome();
  const first = runHeal(home, ["--apply"]);
  assert.equal(first.status, 2, first.stderr || first.out);
  const postShas = dirFingerprints(home);

  const second = runHeal(home, ["--apply"]);
  assert.equal(second.status, 0, second.stderr || second.out);
  assert.ok(second.out.includes("0 repairs applied"), second.out);
  assert.equal(healReceipts(home).length, 1, "second apply wrote no receipt");
  assert.equal(JSON.stringify(postShas), JSON.stringify(dirFingerprints(home)), "second apply changed nothing on disk");
});

test("heal --rollback <id> restores a byte-identical pre-image (criterion 3)", limit, () => {
  const home = makeHome();
  assert.equal(runHeal(home, ["--apply"]).status, 2);

  const rollback = runHeal(home, ["--rollback", expectedReceiptId]);
  assert.equal(rollback.status, 0, rollback.stderr || rollback.out);
  assert.equal(configText(home), preText, "config restored byte-for-byte");
  assert.equal(sha256(configText(home)), sha256(preText), "sha256 equality");
  assert.equal(rollback.out.includes("pre-image store"), false, "rollback says nothing about a store");
});

test("heal --rollback refuses drift, and --force refuses too rather than writing unproven bytes", limit, () => {
  const home = makeHome();
  assert.equal(runHeal(home, ["--apply"]).status, 2);
  writeFileSync(path.join(home, ".claude.json"), '{"mcpServers":{},"tampered":true}', "utf8");

  const refused = runHeal(home, ["--rollback", expectedReceiptId]);
  assert.equal(refused.status, 3, refused.stderr || refused.out);
  assert.ok(refused.out.includes("refused"), refused.out);
  assert.equal(configText(home), '{"mcpServers":{},"tampered":true}', "refused rollback must not touch the live file");

  // Without a stored pre-image, --force cannot fabricate bytes it cannot prove:
  // it warns, tries to rebuild from quarantined[], and refuses when the
  // quarantine block no longer exists.
  const forced = runHeal(home, ["--rollback", expectedReceiptId, "--force"]);
  assert.equal(forced.status, 3, forced.stderr || forced.out);
  assert.ok(forced.out.includes("refused"), forced.out);
  assert.ok(forced.out.includes("intervening changes"), forced.out);
  assert.equal(configText(home), '{"mcpServers":{},"tampered":true}', "a failed forced rollback writes nothing");
});

test("heal --plan on a healthy config is clean: exit 0, no H1, no writes", limit, () => {
  const home = makeHome({ seed: false });
  writeFileSync(path.join(home, ".claude.json"), `{"mcpServers":{"healthy":${healthyText},"placeholder-env":${placeholderText}}}`, "utf8");
  const before = dirFingerprints(home);
  const result = runHeal(home, ["--plan"]);
  assert.equal(result.status, 0, result.stderr || result.out);
  assert.equal((result.out.match(/H1 QUARANTINE-DEAD/g) ?? []).length, 0, result.out);
  assert.equal(JSON.stringify(before), JSON.stringify(dirFingerprints(home)), "plan must not write a single byte");
});

test("heal exits 4 on invalid config JSON and on an unknown rollback id", limit, () => {
  const brokenHome = makeHome();
  writeFileSync(path.join(brokenHome, ".claude.json"), "{ not json", "utf8");
  assert.equal(runHeal(brokenHome, ["--plan"]).status, 4);
  assert.equal(runHeal(brokenHome, ["--apply"]).status, 4);

  const home = makeHome();
  assert.equal(runHeal(home, ["--rollback", "h1-ghost-0000000000000000"]).status, 4);
});

test("receipt ids are deterministic across apply/rollback cycles", limit, () => {
  const home = makeHome();
  const apply1 = runHeal(home, ["--apply"]);
  assert.equal(apply1.status, 2, apply1.stderr || apply1.out);
  assert.deepEqual(healReceipts(home), [`${expectedReceiptId}.json`]);

  assert.equal(runHeal(home, ["--rollback", expectedReceiptId]).status, 0);
  const apply2 = runHeal(home, ["--apply"]);
  assert.equal(apply2.status, 2, apply2.stderr || apply2.out);
  assert.deepEqual(healReceipts(home), [`${expectedReceiptId}.json`], "same input config produced the same receipt id");
});

test("a partial failure history is not death: 2/3 proposes nothing (surface A)", limit, () => {
  const home = makeHome({ seed: false });
  seedFailure(home, "dead", deadText, { count: 2 });
  const before = dirFingerprints(home);

  const planRun = runHeal(home, ["--plan"]);
  assert.equal(planRun.status, 0, planRun.stderr || planRun.out);
  assert.equal((planRun.out.match(/H1 QUARANTINE-DEAD/g) ?? []).length, 0, "2 of 3 consecutive failures must not quarantine");
  assert.ok(planRun.out.includes("2/3 consecutive failed checks"), planRun.out);
  assert.equal(JSON.stringify(before), JSON.stringify(dirFingerprints(home)), "plan still writes nothing");

  const applyRun = runHeal(home, ["--apply"]);
  assert.equal(applyRun.status, 0, applyRun.stderr || applyRun.out);
  assert.equal(healReceipts(home).length, 0, "a partial history never produces a receipt");
  assert.equal(configText(home), preText, "the config is untouched below the threshold");
});

test("history is keyed by the registration bytes: an edited entry starts over (surface A)", limit, () => {
  const home = makeHome({ seed: false });
  const edited = { type: "stdio", command: DEAD_COMMAND, args: ["--changed"] };
  seedFailure(home, "dead", JSON.stringify(edited), { count: 3 });
  // The config still declares the old bytes for "dead", so the seeded hash does
  // not match and the three old failures do not transfer to this registration.
  const result = runHeal(home, ["--plan"]);
  assert.equal(result.status, 0, result.stderr || result.out);
  assert.equal((result.out.match(/H1 QUARANTINE-DEAD/g) ?? []).length, 0, result.out);
});

test("receipts and history stay credential-free; rollback is still byte-exact (surface B)", limit, () => {
  const home = mkdtempSync(path.join(tmpdir(), "mcp-doctor-heal-"));
  const deadSecret = { type: "stdio", command: DEAD_COMMAND, env: { API_KEY: SECRET } };
  const deadSecretText = JSON.stringify(deadSecret);
  const secretPre = `{"mcpServers":{"healthy":${healthyText},"dead":${deadSecretText},"placeholder-env":${placeholderText}}}`;
  writeFileSync(path.join(home, ".claude.json"), secretPre, "utf8");
  seedFailure(home, "dead", deadSecretText);

  const result = runHeal(home, ["--apply"]);
  assert.equal(result.status, 2, result.stderr || result.out);

  // (a) No file anywhere under .mcp-doctor carries the literal, receipts and
  //     history store included.
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else assert.ok(!readFileSync(full, "utf8").includes(SECRET), `${full} leaked the credential`);
    }
  };
  walk(path.join(home, ".mcp-doctor"));
  assert.equal(healReceipts(home).length, 1, "exactly one receipt");
  assert.equal(existsSync(path.join(home, ".mcp-doctor", "pre-images")), false, "no pre-image store exists to leak it");

  // (b) Rollback rebuilds the byte-exact pre-image from quarantined[].
  const receipt = JSON.parse(readFileSync(path.join(home, ".mcp-doctor", "heal", healReceipts(home)[0]), "utf8"));
  const restored = runHeal(home, ["--rollback", receipt.id]);
  assert.equal(restored.status, 0, restored.stderr || restored.out);
  assert.equal(configText(home), secretPre, "rollback restored the byte-exact pre-image including its own env keys");
  assert.equal(sha256(configText(home)), sha256(secretPre), "sha256 equality");
});

test("rollback refuses when quarantined[] no longer matches the recorded bytes (surface B)", limit, () => {
  const home = makeHome();
  assert.equal(runHeal(home, ["--apply"]).status, 2);
  const tampered = configText(home).replace(DEAD_COMMAND, "some-other-command");
  writeFileSync(path.join(home, ".claude.json"), tampered, "utf8");

  const result = runHeal(home, ["--rollback", expectedReceiptId]);
  assert.equal(result.status, 3, result.stderr || result.out);
  assert.ok(result.out.includes("refused"), result.out);
  assert.equal(configText(home), tampered, "refused rollback wrote nothing");
});

test("rollback refuses when the quarantine block was removed (surface B)", limit, () => {
  const home = makeHome();
  assert.equal(runHeal(home, ["--apply"]).status, 2);
  writeFileSync(path.join(home, ".claude.json"), `{"mcpServers":{"healthy":${healthyText},"placeholder-env":${placeholderText}}}`, "utf8");

  const missing = runHeal(home, ["--rollback", expectedReceiptId]);
  assert.equal(missing.status, 3, missing.stderr || missing.out);
  assert.ok(missing.out.includes("refused"), missing.out);
});

test("rollback refuses a receipt whose target is another config path (surface D, §4.2)", limit, () => {
  const homeA = makeHome();
  assert.equal(runHeal(homeA, ["--apply"]).status, 2);
  const homeB = mkdtempSync(path.join(tmpdir(), "mcp-doctor-heal-b-"));
  writeFileSync(path.join(homeB, ".claude.json"), preText, "utf8");
  mkdirSync(path.join(homeB, ".mcp-doctor", "heal"), { recursive: true });
  writeFileSync(
    path.join(homeB, ".mcp-doctor", "heal", `${expectedReceiptId}.json`),
    readFileSync(path.join(homeA, ".mcp-doctor", "heal", `${expectedReceiptId}.json`), "utf8"),
    "utf8"
  );

  const result = runHeal(homeB, ["--rollback", expectedReceiptId]);
  assert.equal(result.status, 3, result.stderr || result.out);
  assert.ok(result.out.includes("refused"), result.out);
  assert.equal(configText(homeB), preText, "a planted receipt must not redirect a write");
});

test("byte surgery survives every dead position, adjacency, CRLF, escapes and pre-existing quarantined[] (surface C)", limit, () => {
  const quarantinedTextFor = (name) =>
    `{"name":"${name}","config":${deadText},"reason":${JSON.stringify(REASON)}}`;
  const cases = [
    { label: "dead first", members: `"dead":${deadText},"alive":${healthyText}`, alive: ["alive"], quarantined: ["dead"] },
    { label: "dead last", members: `"alive":${healthyText},"dead":${deadText}`, alive: ["alive"], quarantined: ["dead"] },
    { label: "dead middle", members: `"alive":${healthyText},"dead":${deadText},"alive2":${healthyText}`, alive: ["alive", "alive2"], quarantined: ["dead"] },
    { label: "dead only member", members: `"dead":${deadText}`, alive: [], quarantined: ["dead"] },
    { label: "two adjacent dead at end", members: `"alive":${healthyText},"d1":${deadText},"d2":${deadText}`, alive: ["alive"], quarantined: ["d1", "d2"] },
    { label: "two adjacent dead in the middle", members: `"a":${healthyText},"d1":${deadText},"d2":${deadText},"z":${healthyText}`, alive: ["a", "z"], quarantined: ["d1", "d2"] },
    { label: "three adjacent dead at end", members: `"alive":${healthyText},"d1":${deadText},"d2":${deadText},"d3":${deadText}`, alive: ["alive"], quarantined: ["d1", "d2", "d3"] },
    { label: "pre-existing non-empty quarantined", doc: `{"quarantined":[{"name":"old","config":{"note":"x"}}],"mcpServers":{"alive":${healthyText},"dead":${deadText}}}`, members: null, alive: ["alive"], quarantined: ["old", "dead"] },
    { label: "pre-existing empty quarantined", doc: `{"quarantined":[],"mcpServers":{"alive":${healthyText},"dead":${deadText}}}`, members: null, alive: ["alive"], quarantined: ["dead"] },
  ];

  for (const c of cases) {
    const home = mkdtempSync(path.join(tmpdir(), "mcp-doctor-surgery-"));
    const doc = c.members === null ? c.doc : `{"mcpServers":{${c.members}}}`;
    writeFileSync(path.join(home, ".claude.json"), doc, "utf8");
    for (const dead of c.quarantined) {
      if (dead === "old") continue;
      seedFailure(home, dead, deadText);
    }

    const result = runHeal(home, ["--apply"]);
    assert.equal(result.status, 2, `${c.label}: ${result.err}`);
    const post = configText(home);
    const parsed = JSON.parse(post); // (1) the result must parse
    assert.ok(!/,\s*}/.test(post), `${c.label}: (2) no dangling comma before a brace`);
    assert.deepEqual(Object.keys(parsed.mcpServers ?? {}).sort(), c.alive.slice().sort(), `${c.label}: (3) survivors exact`);
    assert.deepEqual((parsed.quarantined ?? []).map((q) => q.name), c.quarantined, `${c.label}: (4) quarantined names`);
    if (c.alive.length > 0) {
      assert.ok(post.includes(healthyText), `${c.label}: (5) surviving member bytes intact`);
    }
    for (const dead of c.quarantined) {
      if (dead === "old") continue;
      assert.ok(post.includes(quarantinedTextFor(dead)), `${c.label}: (6) ${dead} quarantined verbatim`);
    }

    // And every one of those shapes still rolls back byte-exactly.
    const id = healReceipts(home)[0].replace(/\.json$/, "");
    const rollback = runHeal(home, ["--rollback", id]);
    assert.equal(rollback.status, 0, `${c.label} rollback: ${rollback.err || rollback.out}`);
    assert.equal(configText(home), doc, `${c.label}: byte-exact pre-image restored`);
  }

  // CRLF file with a dead member between live ones.
  const crlfHome = mkdtempSync(path.join(tmpdir(), "mcp-doctor-crlf-"));
  const crlfDoc = `{\r\n  "mcpServers": {\r\n    "alive": ${healthyText},\r\n    "dead": ${deadText}\r\n  }\r\n}`;
  writeFileSync(path.join(crlfHome, ".claude.json"), crlfDoc, "utf8");
  seedFailure(crlfHome, "dead", deadText);
  const crlfRun = runHeal(crlfHome, ["--apply"]);
  assert.equal(crlfRun.status, 2, crlfRun.err);
  const crlfParsed = JSON.parse(configText(crlfHome));
  assert.deepEqual(crlfParsed.mcpServers.alive, healthyConfig, "CRLF: live value intact");
  assert.deepEqual((crlfParsed.quarantined ?? []).map((q) => q.name), ["dead"], "CRLF: dead quarantined");
  assert.equal(runHeal(crlfHome, ["--rollback", healReceipts(crlfHome)[0].replace(/\.json$/, "")]).status, 0);
  assert.equal(configText(crlfHome), crlfDoc, "CRLF: byte-exact rollback, newlines included");

  // Strings containing escaped braces, commas, quotes and backslashes.
  const evilArg = '{"a":1,"b":"}\\"","}":2}';
  const evilHealthy = { type: "stdio", command: process.execPath, args: [fixture, "success", evilArg] };
  const evilDead = { type: "stdio", command: DEAD_COMMAND, args: [evilArg, ']"},{'] };
  const evilHome = mkdtempSync(path.join(tmpdir(), "mcp-doctor-escapes-"));
  const evilDoc = `{"mcpServers":{"alive":${JSON.stringify(evilHealthy)},"dead":${JSON.stringify(evilDead)}}}`;
  writeFileSync(path.join(evilHome, ".claude.json"), evilDoc, "utf8");
  seedFailure(evilHome, "dead", JSON.stringify(evilDead));
  const evilRun = runHeal(evilHome, ["--apply"]);
  assert.equal(evilRun.status, 2, evilRun.err);
  const evilParsed = JSON.parse(configText(evilHome)); // braces/commas/quotes inside strings survive the scanner
  assert.deepEqual(evilParsed.mcpServers.alive.args, evilHealthy.args, "escapes: live args byte-intact");
  assert.deepEqual(evilParsed.quarantined[0].config.args, evilDead.args, "escapes: quarantined args byte-intact");
});

// --------------------------------------------------------------------- §4.3
// The target is named before it is written: --config as the escape hatch, the
// resolved path as the first line of plan/apply output, and --yes required to
// touch the live profile. Each rail below must fail if it is removed.
const section43 = { timeout: 45000 };

test("§4.3: heal --apply against the live profile without --yes refuses (exit 3, path named, bytes untouched)", section43, () => {
  const home = makeHome();
  const resolved = path.join(home, ".claude.json"); // the only path the CLI may resolve to

  // Guard the test itself first: the rail must never send this test at the
  // real profile, so the named path has to live under the temp home.
  assert.ok(resolved.startsWith(home), "the test fixture must isolate under a temp home");

  const before = dirFingerprints(home);
  const result = runHeal(home, ["--apply"], { ambient: true });
  const combined = result.out + "\n" + result.err;

  assert.ok(combined.includes(resolved), `refusal must name the resolved path under the temp home (got: ${combined})`);
  assert.equal(result.status, 3, `without --yes apply must exit 3 (got ${result.status}: ${combined})`);
  assert.equal(configText(home), preText, "byte-identical: the refusal writes nothing");
  assert.equal(JSON.stringify(before), JSON.stringify(dirFingerprints(home)), "no byte written anywhere under the fixture home");
});

test("§4.3: heal --apply --yes against the temporary live profile proceeds", section43, () => {
  const home = makeHome();
  const result = runHeal(home, ["--apply", "--yes"], { ambient: true });
  assert.equal(result.status, 2, result.err || result.out);
  assert.deepEqual(healReceipts(home), [`${expectedReceiptId}.json`], "--yes apply writes the receipt");
  assert.equal(configText(home), expectedPostText, "--yes apply performs the same byte-surgery");
});

test("§4.3: heal --apply --config <file> proceeds without --yes (naming the file is the confirmation)", section43, () => {
  const home = makeHome();
  const target = path.join(home, "configs", "claude.json");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, preText, "utf8");
  seedFailure(home, "dead", deadText, { configPath: target });

  const result = runHeal(home, ["--apply", "--config", target]);
  assert.equal(result.status, 2, result.err || result.out);
  assert.equal(readFileSync(target, "utf8"), expectedPostText, "--config target got the byte-surgery without --yes");
  const receiptDir = path.join(path.dirname(target), ".mcp-doctor", "heal");
  assert.deepEqual(
    existsSync(receiptDir) ? readdirSync(receiptDir).filter((n) => n.endsWith(".json")) : [],
    [`${expectedReceiptId}.json`],
    "receipts are stored next to the --config target"
  );
  assert.equal(result.out.split("\n")[0], target, "first line of apply output names the explicit target");
});

test("§4.3: the first line of heal --plan output equals the resolved config path", section43, () => {
  const home = makeHome();
  const ambient = runHeal(home, ["--plan"], { ambient: true });
  assert.equal(
    ambient.out.split("\n")[0],
    path.join(home, ".claude.json"),
    `the first line must be the resolved path, plain (got: ${ambient.out.split("\n")[0]})`
  );

  const target = path.join(home, "configs", "claude.json");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, preText, "utf8");
  const scoped = runHeal(home, ["--plan", "--config", target]);
  assert.equal(scoped.out.split("\n")[0], target, "with --config the first line is exactly the named target");
});

test("§4.3: --config pointing at a nonexistent file exits 4, names the path, and creates nothing", section43, () => {
  const home = makeHome();
  const target = path.join(home, "missing", "claude.json");

  const before = dirFingerprints(home);
  const apply = runHeal(home, ["--apply", "--config", target]);
  const combined = apply.out + "\n" + apply.err;
  assert.equal(apply.status, 4, `nonexistent --config must exit 4 (got ${apply.status}: ${combined})`);
  assert.ok(combined.includes(target), `the error must name the missing path (got: ${combined})`);
  assert.ok(!existsSync(target), "the missing file must not be created");
  const plan = runHeal(home, ["--plan", "--config", target]);
  assert.equal(plan.status, 4, "plan mode gets the same refusal");
  assert.equal(JSON.stringify(dirFingerprints(home)), JSON.stringify(before), "no byte written");
});
