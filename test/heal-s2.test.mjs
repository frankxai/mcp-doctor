// Surface-closing proofs for the 2026-11-08 verifier's risk table.
//
// A: three *separate* audit invocations, persisted, interval-gated, reset on
//    success. One transient probe failure never quarantines anything.
// B: no artifact under .mcp-doctor carries a literal credential, and rollback
//    still restores byte-exactly.
// C: every adversarial JSON shape produces valid output with no dangling comma
//    and no partial write.
// D: receipts land before the config; a blocked receipt write leaves the config
//    untouched; --force names the changes it discards.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const cli = path.join(root, "dist", "cli.js");
const fixture = path.join(here, "fixtures", "health-probe.mjs");

const DEAD_COMMAND = "mcp-doctor-h1-fixture-missing-binary";
const SECRET = "sk-0000000000000000000000s2secret";
const healthyConfig = { type: "stdio", command: process.execPath, args: [fixture, "success"] };
const deadConfig = { type: "stdio", command: DEAD_COMMAND };
const silentConfig = { type: "stdio", command: process.execPath, args: [fixture, "silent"] };
const healthyText = JSON.stringify(healthyConfig);
const deadText = JSON.stringify(deadConfig);
const preText = `{"mcpServers":{"healthy":${healthyText},"dead":${deadText}}}`;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const strip = (text) => (text ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const limit = { timeout: 120000 };

function envFor(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData"),
    LOCALAPPDATA: path.join(home, "LocalAppData"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    MCP_DOCTOR_HEAL_MIN_INTERVAL_MS: "0",
    ...extra,
  };
}

function makeHome(text = preText) {
  const home = mkdtempSync(path.join(tmpdir(), "mcp-doctor-s2-"));
  writeFileSync(path.join(home, ".claude.json"), text, "utf8");
  return home;
}

function run(home, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    env: envFor(home, extraEnv),
    cwd: home,
    encoding: "utf8",
    timeout: 110000,
  });
  return { ...result, out: strip(result.stdout), err: strip(result.stderr) };
}

function audit(home, extraEnv = {}) {
  return run(home, ["audit"], extraEnv);
}

function plan(home) {
  return run(home, ["heal", "--plan", "--config", path.join(home, ".claude.json")]);
}

function apply(home) {
  return run(home, ["heal", "--apply", "--config", path.join(home, ".claude.json")]);
}

function history(home) {
  const file = path.join(home, ".mcp-doctor", "failure-history.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, records: {} };
}

function recordFor(home, server) {
  return Object.values(history(home).records).find((record) => record.server === server);
}

function configText(home) {
  return readFileSync(path.join(home, ".claude.json"), "utf8");
}

// ---------------------------------------------------------------- surface A

test("A: a misconfigured entry is reported, never counted as dead (finding 2)", limit, () => {
  // No command at all: the old classification called this `broken`, heal counted
  // it, and three audits would have quarantined a config a human must fix.
  const doc = `{"mcpServers":{"healthy":${healthyText},"no-command":{"type":"stdio"}}}`;
  const home = makeHome(doc);
  for (let i = 0; i < 3; i++) assert.equal(audit(home).status, 0);

  assert.equal(recordFor(home, "no-command"), undefined, "a malformed entry is not failure evidence");
  const planned = plan(home);
  assert.equal(planned.status, 0, planned.out);
  assert.equal((planned.out.match(/H1 QUARANTINE-DEAD/g) ?? []).length, 0, "a misconfigured server is never quarantined");
  assert.ok(planned.out.includes("misconfigured: No command configured"), planned.out);
  assert.equal(apply(home).status, 0);
  assert.equal(configText(home), doc, "the user's configuration is intact");
});

test("A: a probe failure that is not a missing binary is not death (finding 2)", limit, () => {
  // The command exists and starts, then fails the handshake. This is the shape
  // of an offline npx, an expired upstream token or a bad protocol version.
  const failing = { type: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] };
  const doc = `{"mcpServers":{"healthy":${healthyText},"failing":${JSON.stringify(failing)}}}`;
  const home = makeHome(doc);
  for (let i = 0; i < 3; i++) assert.equal(audit(home).status, 0);

  assert.equal(recordFor(home, "failing"), undefined, "a `broken` probe is not a counted failure");
  const planned = plan(home);
  assert.equal(planned.status, 0, planned.out);
  assert.equal((planned.out.match(/H1 QUARANTINE-DEAD/g) ?? []).length, 0);
  assert.equal(apply(home).status, 0);
  assert.equal(configText(home), doc);
});

test("A: one failed check does not quarantine; three separate invocations do", limit, () => {
  const home = makeHome();

  const first = audit(home);
  assert.equal(first.status, 0, first.err);
  assert.equal(recordFor(home, "dead")?.consecutiveFailures, 1, "one audit run counts once");
  assert.equal(plan(home).status, 0, "1/3 must propose nothing");

  const second = audit(home);
  assert.equal(second.status, 0, second.err);
  assert.equal(recordFor(home, "dead")?.consecutiveFailures, 2, "a second run counts again");
  assert.equal(plan(home).status, 0, "2/3 must propose nothing");
  assert.equal(apply(home).status, 0, "2/3 must apply nothing");
  assert.equal(configText(home), preText, "the config is untouched below the threshold");

  const third = audit(home);
  assert.equal(third.status, 0, third.err);
  const record = recordFor(home, "dead");
  assert.equal(record?.consecutiveFailures, 3, "three runs are three counted failures");
  assert.equal(record?.lastStatus, "missing-command");

  const planned = plan(home);
  assert.equal(planned.status, 1, planned.out);
  assert.equal((planned.out.match(/H1 QUARANTINE-DEAD/g) ?? []).length, 1, "exactly one H1 after 3/3");
});

test("A: the count is gated by a minimum interval between counted failures", limit, () => {
  const home = makeHome();
  // Default interval is a minute; three back-to-back runs must not add up.
  const noOverride = { MCP_DOCTOR_HEAL_MIN_INTERVAL_MS: "" };
  audit(home, noOverride);
  audit(home, noOverride);
  audit(home, noOverride);
  assert.equal(recordFor(home, "dead")?.consecutiveFailures, 1, "a burst of runs is one blip");
  assert.equal(plan(home).status, 0, "a burst never reaches 3/3");

  // The interval is real arithmetic, not a constant: with it elapsed (0ms) the
  // same store increments again.
  audit(home, { MCP_DOCTOR_HEAL_MIN_INTERVAL_MS: "0" });
  assert.equal(recordFor(home, "dead")?.consecutiveFailures, 2);
});

test("A: a success resets the count, and a later failure starts from one", limit, () => {
  const home = makeHome();
  audit(home);
  audit(home);
  assert.equal(recordFor(home, "dead")?.consecutiveFailures, 2);

  // Make the same registration succeed.
  const fixedText = `{"mcpServers":{"healthy":${healthyText},"dead":${healthyText}}}`;
  writeFileSync(path.join(home, ".claude.json"), fixedText, "utf8");
  audit(home);
  assert.equal(recordFor(home, "dead"), undefined, "success resets and forgets the record");

  // Broken again: history restarts at one, not at three.
  writeFileSync(path.join(home, ".claude.json"), preText, "utf8");
  audit(home);
  assert.equal(recordFor(home, "dead")?.consecutiveFailures, 1);
  assert.equal(plan(home).status, 0);
});

test("A: a timing failure is not evidence either way and never counts", limit, () => {
  const home = makeHome(`{"mcpServers":{"healthy":${healthyText},"flaky":${JSON.stringify(silentConfig)}}}`);
  audit(home);
  assert.equal(recordFor(home, "flaky"), undefined, "a timeout neither increments nor resets");
  const planned = plan(home);
  assert.equal(planned.status, 0, planned.out);
  assert.equal((planned.out.match(/H1 QUARANTINE-DEAD/g) ?? []).length, 0, "a slow server is never quarantined");
});

test("A: plan and apply read the same store and cannot disagree", limit, () => {
  const home = makeHome();
  audit(home);
  audit(home);
  audit(home);

  // Freeze the evidence: change nothing, then apply. The plan's proposal and
  // the applied set are the same because neither re-probes.
  const planned = plan(home);
  const applyRun = apply(home);
  assert.equal(planned.status, 1);
  assert.equal(applyRun.status, 2, applyRun.err || applyRun.out);
  const appliedNames = [...applyRun.out.matchAll(/H1 quarantined (\S+)/g)].map((m) => m[1]);
  const plannedNames = [...planned.out.matchAll(/H1 QUARANTINE-DEAD (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(appliedNames, plannedNames, "apply executed exactly what plan proposed");

  // A config the store has never seen proposes nothing, even if its command is
  // obviously missing: there is no evidence, so there is no repair.
  const fresh = makeHome();
  assert.equal(plan(fresh).status, 0);
  assert.equal(apply(fresh).status, 0);
  assert.equal(configText(fresh), preText);
});

// ---------------------------------------------------------------- surface B

test("B: no file under .mcp-doctor carries the literal credential, and rollback is byte-exact", limit, () => {
  const secretDead = { type: "stdio", command: DEAD_COMMAND, env: { API_KEY: SECRET } };
  const secretText = JSON.stringify(secretDead);
  const doc = `{"mcpServers":{"healthy":${healthyText},"dead":${secretText}}}`;
  const home = makeHome(doc);

  audit(home);
  audit(home);
  audit(home);

  // The history store is written by the recording path; it must not quote the
  // command, the env key's value, or any message.
  const historyText = readFileSync(path.join(home, ".mcp-doctor", "failure-history.json"), "utf8");
  assert.ok(!historyText.includes(SECRET), "failure history carries no credential");
  assert.ok(!historyText.includes("API_KEY"), "failure history carries no env key names either");

  const applied = apply(home);
  assert.equal(applied.status, 2, applied.err || applied.out);

  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else assert.ok(!readFileSync(full, "utf8").includes(SECRET), `${full} leaked the credential`);
    }
  };
  walk(path.join(home, ".mcp-doctor"));

  const receiptName = readdirSync(path.join(home, ".mcp-doctor", "heal")).find((n) => n.endsWith(".json"));
  const receipt = JSON.parse(readFileSync(path.join(home, ".mcp-doctor", "heal", receiptName), "utf8"));
  assert.ok(!JSON.stringify(receipt).includes(SECRET), "the receipt itself is credential-free");
  assert.ok(receipt.reconstruction, "the receipt carries reconstruction metadata instead of the value");

  const id = receiptName.replace(/\.json$/, "");
  const rolled = run(home, ["heal", "--rollback", id, "--config", path.join(home, ".claude.json")]);
  assert.equal(rolled.status, 0, rolled.err || rolled.out);
  assert.equal(configText(home), doc, "byte-exact restore, secret-bearing entry included");
  assert.equal(sha256(configText(home)), sha256(doc));
});

test("B: a credential in args reaches no artifact; the receipt stays structural (finding 1)", limit, () => {
  // The reviewer's reproduction: a password in an argument after a flag whose
  // name matches neither redaction heuristic. The old receipt copied the raw
  // entry and leaked this value verbatim.
  const credential = "pgpasswordZx9SecretValue";
  const connection = `postgres://admin:${credential}@db.internal:5432/prod`;
  const entry = { type: "stdio", command: "definitely-not-a-real-binary-xyz", args: ["--connection-string", connection] };
  const doc = `{"mcpServers":{"DEAD_DB":${JSON.stringify(entry)}}}`;
  const home = makeHome(doc);
  for (let i = 0; i < 3; i++) assert.equal(audit(home).status, 0, "the absent binary is a counted failure");

  const applied = apply(home);
  assert.equal(applied.status, 2, applied.err || applied.out);

  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else assert.ok(!readFileSync(full, "utf8").includes(credential), `${full} leaked the credential`);
    }
  };
  walk(path.join(home, ".mcp-doctor"));

  const receiptName = readdirSync(path.join(home, ".mcp-doctor", "heal")).find((n) => n.endsWith(".json"));
  const receiptText = readFileSync(path.join(home, ".mcp-doctor", "heal", receiptName), "utf8");
  assert.ok(!receiptText.includes(credential), "the receipt carries no credential value");
  assert.ok(!receiptText.includes("postgres://"), "not even the URL shape survives in the receipt");

  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.server, "DEAD_DB", "a reader can still tell which server moved");
  assert.deepEqual(receipt.diff.removedEntries[0].keys, ["type", "command", "args"], "and what settings it had");
  const argRef = receipt.diff.removedEntries[0].values.find((v) => v.path === "args[1]");
  assert.ok(argRef, "the argument value is represented");
  assert.equal(argRef.type, "string");
  assert.match(argRef.sha256, /^[a-f0-9]{64}$/, "as a hash reference, not a value");
  assert.equal(argRef.sha256, sha256(JSON.stringify(connection)), "the hash identifies the exact value");
});

test("B: a receipt cannot redirect a rollback to a path the user did not name", limit, () => {
  const home = makeHome();
  audit(home);
  audit(home);
  audit(home);
  assert.equal(apply(home).status, 2);

  const receiptName = readdirSync(path.join(home, ".mcp-doctor", "heal")).find((n) => n.endsWith(".json"));
  const receiptPath = path.join(home, ".mcp-doctor", "heal", receiptName);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.configPath = path.join(home, "someone-elses-config.json");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), "utf8");

  const result = run(home, ["heal", "--rollback", receiptName.replace(/\.json$/, ""), "--config", path.join(home, ".claude.json")]);
  assert.equal(result.status, 3, result.err || result.out);
  assert.ok(result.out.includes("is not the config"), result.out);
  assert.equal(existsSync(path.join(home, "someone-elses-config.json")), false, "nothing was created at the planted path");
});

// ---------------------------------------------------------------- surface C

test("C: every adversarial shape is valid JSON with no dangling comma and a byte-exact rollback", limit, () => {
  const cases = [
    { label: "dead first", members: `"dead":${deadText},"alive":${healthyText}` },
    { label: "dead last", members: `"alive":${healthyText},"dead":${deadText}` },
    { label: "two adjacent dead, live tail", members: `"d1":${deadText},"d2":${deadText},"alive":${healthyText}` },
    { label: "dead only member", members: `"dead":${deadText}` },
    { label: "three dead ending the object", members: `"alive":${healthyText},"d1":${deadText},"d2":${deadText},"d3":${deadText}` },
    { label: "two adjacent dead ending the object", members: `"alive":${healthyText},"d1":${deadText},"d2":${deadText}` },
  ];

  for (const c of cases) {
    const home = makeHome(`{"mcpServers":{${c.members}}}`);
    // Three real audit runs record every dead registration in this config.
    for (let i = 0; i < 3; i++) {
      assert.equal(audit(home).status, 0);
    }
    const applied = apply(home);
    assert.equal(applied.status, 2, `${c.label}: ${applied.err || applied.out}`);
    const post = configText(home);
    assert.doesNotThrow(() => JSON.parse(post), `${c.label}: output must parse`);
    assert.ok(!/,\s*}/.test(post), `${c.label}: no dangling comma`);
    assert.ok(!/,\s*\]/.test(post), `${c.label}: no dangling comma before an array close`);

    const id = readdirSync(path.join(home, ".mcp-doctor", "heal"))[0].replace(/\.json$/, "");
    const rolled = run(home, ["heal", "--rollback", id, "--config", path.join(home, ".claude.json")]);
    assert.equal(rolled.status, 0, `${c.label} rollback: ${rolled.err || rolled.out}`);
    assert.equal(configText(home), `{"mcpServers":{${c.members}}}`, `${c.label}: byte-exact`);
  }
});

test("C: CRLF and escaped bytes survive apply and rollback byte-exactly", limit, () => {
  const doc = `{\r\n\t"mcpServers": {\r\n\t\t"alive": ${healthyText},\r\n\t\t"dead": ${deadText}\r\n\t}\r\n}\r\n`;
  const home = makeHome(doc);
  for (let i = 0; i < 3; i++) audit(home);
  const applied = apply(home);
  assert.equal(applied.status, 2, applied.err || applied.out);
  assert.ok(configText(home).includes("\r\n"), "CRLF bytes are preserved in the output");
  const id = readdirSync(path.join(home, ".mcp-doctor", "heal"))[0].replace(/\.json$/, "");
  assert.equal(run(home, ["heal", "--rollback", id, "--config", path.join(home, ".claude.json")]).status, 0);
  assert.equal(configText(home), doc, "CRLF pre-image restored byte-for-byte");
});

// ---------------------------------------------------------------- surface D

test("D: the artifact writer leaves no temp file and replaces contents in one step", limit, () => {
  const home = makeHome();
  for (let i = 0; i < 3; i++) audit(home);
  assert.equal(apply(home).status, 2);
  const leftovers = readdirSync(home).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "no temp file survives the config write");
  const receiptDir = path.join(home, ".mcp-doctor", "heal");
  assert.deepEqual(readdirSync(receiptDir).filter((name) => name.includes(".tmp-")), [], "no temp file survives a receipt write");
});

test("D: config mode is preserved and a symlinked profile survives apply and rollback (finding 4)", { timeout: 120000 }, () => {
  const home = mkdtempSync(path.join(tmpdir(), "mcp-doctor-symlink-"));
  const real = path.join(home, "real-claude.json");
  const link = path.join(home, ".claude.json");
  writeFileSync(real, preText, "utf8");
  chmodSync(real, 0o600);

  // Windows without Developer Mode refuses file symlinks (EPERM), which is a
  // privilege limit, not a code path. Fall back to a regular config there so
  // the structural assertions below still run on this host; the link and mode
  // assertions stay gated, and POSIX must always get a real link.
  let linked = true;
  try {
    symlinkSync(real, link);
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES", "EINVAL"].includes(error.code)) throw error;
    writeFileSync(link, preText, "utf8");
    linked = false;
  }
  if (process.platform !== "win32") assert.equal(linked, true, "the fixture must be a real symlink on POSIX");
  const config = linked ? real : link;

  for (let i = 0; i < 3; i++) assert.equal(audit(home).status, 0);

  const applied = apply(home);
  assert.equal(applied.status, 2, applied.err || applied.out);
  if (linked) {
    assert.equal(lstatSync(link).isSymbolicLink(), true, "the user's symlink is still a symlink");
  }

  // The post-image moved the entry into quarantined[]. Ask the parsed document,
  // not a substring: `"dead"` also occurs as the quarantine entry's name, and
  // `"dead":` is a member-key check that a substring can satisfy for the wrong
  // reason. The structural facts are: gone from mcpServers, present once in
  // quarantined[] with its name and config intact.
  const post = JSON.parse(readFileSync(config, "utf8"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(post.mcpServers ?? {}, "dead"),
    false,
    "the dead server is no longer a member of mcpServers",
  );
  assert.equal(Array.isArray(post.quarantined), true, "quarantined[] is an array");
  assert.equal(post.quarantined.length, 1, "exactly one entry moved into quarantined[]");
  assert.equal(post.quarantined[0].name, "dead", "the quarantined entry preserves the server name");
  assert.deepEqual(post.quarantined[0].config, deadConfig, "and its config, intact");

  if (!linked) {
    // The fallback file is the config the run wrote, so the same structural
    // facts are proven on this host; only symlink identity and POSIX mode wait.
    assert.equal(readFileSync(config, "utf8").includes('"dead":'), false, "the member key is gone from the file");
  }
  if (process.platform !== "win32") {
    assert.equal(statSync(config).mode & 0o777, 0o600, "the config keeps its restrictive mode through the write");
  }

  const receiptName = readdirSync(path.join(home, ".mcp-doctor", "heal")).find((n) => n.endsWith(".json"));
  if (process.platform !== "win32") {
    assert.equal(statSync(path.join(home, ".mcp-doctor", "heal", receiptName)).mode & 0o777, 0o600, "receipts are 0600");
  }

  const rolled = run(home, ["heal", "--rollback", receiptName.replace(/\.json$/, ""), "--config", link]);
  assert.equal(rolled.status, 0, rolled.err || rolled.out);
  if (linked) {
    assert.equal(lstatSync(link).isSymbolicLink(), true, "rollback keeps the link too");
  }
  if (process.platform !== "win32") {
    assert.equal(statSync(config).mode & 0o777, 0o600);
  }
  assert.equal(readFileSync(config, "utf8"), preText, "byte-exact pre-image restored through the config path");
});

test("D: receipts are written before the config; a blocked receipt leaves the config untouched", limit, () => {
  const home = makeHome();
  for (let i = 0; i < 3; i++) audit(home);

  // Make the receipt path unwritable by occupying it with a directory.
  const receiptDir = path.join(home, ".mcp-doctor", "heal");
  mkdirSync(receiptDir, { recursive: true });
  const id = `h1-dead-${sha256(`H1\u0000dead\u0000${preText}`).slice(0, 16)}`;
  mkdirSync(path.join(receiptDir, `${id}.json`));

  const result = apply(home);
  assert.equal(result.status, 4, `a blocked receipt must fail the repair (got ${result.status})`);
  assert.equal(configText(home), preText, "the config was never reached: receipts go first");

  // Leave no temp debris behind either.
  const leftovers = readdirSync(receiptDir).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "atomic writes leave no temp files");
});

test("D: --force names the intervening changes it would discard", limit, () => {
  const home = makeHome();
  for (let i = 0; i < 3; i++) audit(home);
  assert.equal(apply(home).status, 2);
  const id = readdirSync(path.join(home, ".mcp-doctor", "heal"))[0].replace(/\.json$/, "");

  writeFileSync(path.join(home, ".claude.json"), configText(home) + "\n", "utf8"); // one trailing byte of drift
  const forced = run(home, ["heal", "--rollback", id, "--config", path.join(home, ".claude.json"), "--force"]);
  const combined = forced.out + forced.err;
  assert.ok(combined.includes("intervening changes"), `--force must warn about discarded changes (got: ${combined})`);
  assert.equal(forced.status, 3, "unprovable reconstruction refuses rather than writing");
  assert.equal(configText(home).endsWith("\n"), true, "the drifted file is untouched");
});

test("D: apply and rollback leave no temp artifacts in the config directory", limit, () => {
  const home = makeHome();
  for (let i = 0; i < 3; i++) audit(home);
  assert.equal(apply(home).status, 2);
  const id = readdirSync(path.join(home, ".mcp-doctor", "heal"))[0].replace(/\.json$/, "");
  assert.equal(run(home, ["heal", "--rollback", id, "--config", path.join(home, ".claude.json")]).status, 0);
  const leftovers = readdirSync(home).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "atomic config writes leave no temp files");
});
