import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.MCP_DOCTOR_CONSUMER_ROOT ?? path.join(here, ".."));
const fixture = path.join(here, "fixtures", "health-probe.mjs");
const cli = path.join(root, "dist", "cli.js");
const { checkServerHealth, checkAllServers } = await import(pathToFileURL(path.join(root, "dist", "scanner", "health-checker.js")).href);
const { checkServer } = await import(pathToFileURL(path.join(root, "dist", "checker", "check-server.js")).href);
console.log(JSON.stringify({ verification: process.env.MCP_DOCTOR_CONSUMER_ROOT ? "installed-tarball" : "workspace-build", node: process.version, platform: process.platform, package: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version }));

const scratch = () => mkdtempSync(path.join(tmpdir(), "mcp-doctor-health-"));
function envFor(home) {
  return { ...getDefaultEnvironment(), HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData"), LOCALAPPDATA: path.join(home, "LocalAppData"), XDG_CONFIG_HOME: path.join(home, "xdg") };
}
function entry(mode, extraEnv = {}, extraArgs = []) {
  const home = scratch();
  const trace = path.join(home, "probe.jsonl");
  return { name: mode, scope: "user", config: { type: "stdio", command: process.execPath, args: [fixture, mode, ...extraArgs], env: { PROBE_TRACE: trace, ...extraEnv } } };
}
function events(server) {
  return readFileSync(server.config.env.PROBE_TRACE, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
function reaped(server) {
  const pid = events(server)[0].pid;
  assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH", "owned fixture " + pid + " exited before the probe returned");
}
async function probe(mode, timeout = 3000, extraEnv = {}, args = []) {
  const server = entry(mode, extraEnv, args);
  const result = await checkServerHealth(server, timeout);
  reaped(server);
  return { server, result };
}
const limit = { timeout: 12000 };

test("valid initialize and ping establish health, followed by actual child exit", limit, async () => {
  const { server, result } = await probe("success");
  assert.equal(result.status, "healthy");
  assert.equal(result.message, "MCP handshake verified");
  const methods = events(server).map((row) => row.event);
  assert.ok(methods.includes("initialize"));
  assert.ok(methods.includes("notifications/initialized"));
  assert.ok(methods.includes("ping"));
});
test("resources-only health never invokes tools/list", limit, async () => {
  const { server, result } = await probe("resources-only");
  assert.equal(result.status, "healthy");
  assert.ok(!events(server).some((row) => row.event === "tools/list"));
});
test("clean early exit is broken, not protocol health", limit, async () => {
  assert.equal((await probe("exit-0")).result.status, "broken");
});
test("silent initialize and silent ping both time out", limit, async () => {
  for (const mode of ["silent", "init-only"]) assert.equal((await probe(mode, 750)).result.status, "timeout");
});
for (const mode of ["malformed", "wrong-id", "wrong-id-then-valid", "rpc-error", "unsupported-version", "ping-error", "oversize"]) {
  test("live " + mode + " fixture never establishes health", limit, async () => {
    const { result } = await probe(mode, 1500, { PROBE_RPC_SECRET: "sentinel_rpc_error_should_not_escape" });
    assert.ok(["broken", "timeout"].includes(result.status), result.status);
    assert.ok(!result.message.includes("sentinel_rpc_error"));
    assert.ok((result.detail?.length ?? 0) <= 2048);
  });
}
test("configured argv/env secrets split across stderr chunks are redacted", limit, async () => {
  const secret = "sentinel_env_secret_for_redaction";
  const arg = "sentinel_arg_secret_for_redaction";
  const { result } = await probe("secret-leak", 3000, { PROBE_SECRET: secret }, ["--token=" + arg]);
  assert.equal(result.status, "broken");
  assert.ok(result.detail?.includes("[REDACTED:PROBE_SECRET]"));
  assert.ok(result.detail?.includes("[REDACTED:ARG]"));
  assert.ok(result.detail?.includes("[REDACTED:ANTHROPIC_KEY]"));
  assert.ok(!result.detail.includes(secret) && !result.detail.includes(arg));
});
test("oversized stderr lines are dropped before secret-bearing output is retained", limit, async () => {
  const { result } = await probe("stderr-oversize", 3000, { PROBE_SECRET: "sentinel_oversized_line_secret" }, ["--token=sentinel_oversized_arg_secret"]);
  assert.equal(result.status, "broken");
  assert.ok(result.detail?.includes("oversized stderr line omitted"));
  assert.ok(!result.detail.includes("sentinel_oversized"));
});
test("short configured credentials are still redacted", limit, async () => {
  const { result } = await probe("secret-leak", 3000, { PROBE_SECRET: "p4ss" }, ["--token=abc"]);
  assert.equal(result.status, "broken");
  assert.ok(!result.detail.includes("p4ss"));
  assert.ok(!result.detail.includes("abc"));
});
test("parent Node injection settings and credentials are not inherited", limit, async () => {
  const keys = ["NODE_OPTIONS", "NODE_PATH", "PARENT_CREDENTIAL"];
  const before = keys.map((key) => process.env[key]);
  try {
    process.env.NODE_OPTIONS = "--max-old-space-size=64";
    process.env.NODE_PATH = "sentinel_parent_node_path";
    process.env.PARENT_CREDENTIAL = "sentinel_parent_credential";
    assert.equal((await probe("env-check")).result.status, "healthy");
  } finally {
    keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; });
  }
});
test("SDK argv resolution supports bare node as well as the absolute executable", limit, async () => {
  const server = entry("success");
  server.config.command = "node";
  const result = await checkServerHealth(server, 3000);
  reaped(server);
  assert.equal(result.status, "healthy");
});
test("termination resistance is real and the SDK reaps it on success and timeout", { timeout: 16000 }, async () => {
  for (const mode of ["resistant", "resistant-silent"]) {
    const start = Date.now();
    const { server, result } = await probe(mode, 1500);
    assert.equal(result.status, mode === "resistant" ? "healthy" : "timeout");
    assert.ok(Date.now() - start < 7500, "probe plus cleanup deadline stayed bounded");
    if (process.platform !== "win32") assert.ok(events(server).some((row) => row.event === "sigterm-ignored"));
  }
});
test("quick checks never start the executable, even with configuration failures", async () => {
  const good = entry("success");
  const bad = entry("success", { TOKEN: "YOUR_TOKEN" });
  const missing = { ...entry("success"), config: { type: "stdio" } };
  const result = await checkAllServers([good, bad, missing], { quick: true });
  assert.deepEqual(result.map((row) => row.status), ["unchecked", "missing-env", "broken"]);
  assert.ok(result.every((row) => row.responseTimeMs === undefined));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!existsSync(good.config.env.PROBE_TRACE));
  assert.ok(!existsSync(bad.config.env.PROBE_TRACE));
});
test("invalid deadlines do not start a child", async () => {
  for (const timeout of [0, -1, NaN, Infinity, 2147483648, 1.5]) {
    const server = entry("success");
    assert.equal((await checkServerHealth(server, timeout)).status, "broken");
    assert.ok(!existsSync(server.config.env.PROBE_TRACE));
  }
});
test("malformed command arguments fail configuration checks without starting children", async () => {
  for (const args of ["--token=sentinel", [null], [42]]) {
    const server = entry("success");
    server.config.args = args;
    assert.equal((await checkServerHealth(server)).status, "broken");
    assert.ok(!existsSync(server.config.env.PROBE_TRACE));
  }
});
test("missing command is a failed probe with no raw exception text", limit, async () => {
  const server = entry("success");
  server.config.command = "mcp-doctor-fixture-command-does-not-exist";
  const result = await checkServerHealth(server, 750);
  assert.ok(["missing-command", "broken"].includes(result.status));
  assert.ok(!existsSync(server.config.env.PROBE_TRACE));
});
test("tool check shares the SDK probe while keeping lint separate from health", limit, async () => {
  const report = await checkServer(process.execPath, [fixture, "tools"], 3000);
  assert.equal(report.ok, true);
  assert.deepEqual(report.tools, ["fixture_echo"]);
});

function configHome(servers) {
  const home = scratch();
  writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }));
  return home;
}
function runCli(home, args) {
  const result = spawnSync(process.execPath, [cli, ...args], { env: envFor(home), cwd: home, encoding: "utf8", timeout: 20000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
}
test("CLI quick bad config and full remote-only setups remain unrated", limit, () => {
  const bad = configHome({ bad: { type: "stdio" } });
  const quick = runCli(bad, ["audit", "--quick"]);
  assert.match(quick, /MCP Health Score: unverified/);
  assert.ok(!quick.includes("/100"));
  const remote = configHome({ remote: { type: "streamable-http", url: "https://example.invalid/mcp" } });
  assert.match(runCli(remote, ["audit"]), /MCP Health Score: unverified/);
});
test("CLI full score uses protocol outcomes without double-counting removal advice", limit, () => {
  const home = configHome({ good: entry("success").config, bad: entry("exit-0").config });
  const output = runCli(home, ["audit"]);
  assert.match(output, /1 healthy/);
  assert.match(output, /1 broken/);
  assert.match(output, /MCP Health Score: 50\/100/);
});
test("CLI proposed commands and diagnostics never echo configured secrets", limit, () => {
  const secret = "sentinel_cli_configured_secret";
  const token = "sentinel_cli_token_argument";
  const server = entry("secret-leak", { PROBE_SECRET: secret }, ["--token=" + token]);
  const home = configHome({ secret: server.config });
  const output = runCli(home, ["audit"]);
  assert.ok(!output.includes(secret) && !output.includes(token));
});
test("actual MCP audit keeps quick configuration errors unrated and full runtime outcomes accurate", { timeout: 20000 }, async () => {
  const rpcSecret = "sentinel_mcp_rpc_secret";
  const home = configHome({ good: entry("success").config, bad: entry("rpc-error", { PROBE_RPC_SECRET: rpcSecret }).config, unconfigured: { type: "stdio" } });
  const client = new Client({ name: "health-test", version: "0.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "serve"], env: envFor(home), cwd: home, stderr: "pipe" }));
    const quick = await client.callTool({ name: "mcp_doctor_audit", arguments: { quick: true } });
    assert.equal(quick.structuredContent.summary.healthy, 0);
    assert.equal(quick.structuredContent.summary.healthScore, null);
    const full = await client.callTool({ name: "mcp_doctor_audit", arguments: { quick: false } });
    assert.equal(full.structuredContent.summary.healthy, 1);
    assert.equal(full.structuredContent.summary.healthScore, 50);
    assert.ok(!JSON.stringify(full).includes(rpcSecret));
  } finally { await client.close(); }
});
