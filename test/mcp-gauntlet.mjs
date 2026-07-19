#!/usr/bin/env node
// MCP gauntlet for mcp-doctor `serve` mode.
// Boots the server over stdio and proves the MCP contract:
//   initialize -> tools/list -> per-tool tools/call (minimal valid input) -> error handling.
// Exit 0 = all pass.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "cli.js");

let pass = 0, fail = 0;
const fails = [];
const ok = (m) => { pass++; console.log(`  PASS ${m}`); };
const bad = (m) => { fail++; fails.push(m); console.log(`  FAIL ${m}`); };

// Spawn server, send a batch of newline-delimited JSON-RPC messages, collect responses by id.
function rpcSession(messages, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const responses = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error("timeout waiting for responses")); }, timeoutMs);

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { responses.push(JSON.parse(line)); } catch { /* non-json log line, ignore */ }
      }
    });
    child.on("error", reject);

    // Send all messages, then close stdin after a beat so the server can flush.
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
    setTimeout(() => child.stdin.end(), 1500);

    child.on("close", () => { clearTimeout(timer); resolve(responses); });
  });
}

const EXPECTED_TOOLS = ["audit", "detect_agents", "find_misplaced", "recommend"];

async function main() {
  console.log("== MCP gauntlet: mcp-doctor serve ==\n");

  // Build the full handshake + a call for every tool (minimal valid args) + an unknown-tool probe.
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gauntlet", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "audit", arguments: { quick: true } } },
    { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "detect_agents", arguments: {} } },
    { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "find_misplaced", arguments: {} } },
    { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "recommend", arguments: {} } },
    { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "does_not_exist", arguments: {} } },
  ];

  const res = await rpcSession(msgs);
  const byId = new Map(res.filter(r => r.id != null).map(r => [r.id, r]));

  // 1. initialize
  const init = byId.get(1);
  if (init?.result?.serverInfo?.name === "mcp-doctor") ok(`initialize -> serverInfo.name=mcp-doctor v${init.result.serverInfo.version}`);
  else bad(`initialize handshake (got ${JSON.stringify(init)?.slice(0,120)})`);
  if (init?.result?.protocolVersion) ok(`initialize -> protocolVersion ${init.result.protocolVersion}`);
  else bad("initialize missing protocolVersion");

  // 2. tools/list — claimed vs real
  const list = byId.get(2);
  const tools = list?.result?.tools || [];
  console.log(`\n  tools/list returned ${tools.length} tools: ${tools.map(t=>t.name).join(", ")}`);
  if (tools.length === EXPECTED_TOOLS.length) ok(`tool count = ${tools.length} (matches implementation)`);
  else bad(`tool count ${tools.length} != expected ${EXPECTED_TOOLS.length}`);
  for (const name of EXPECTED_TOOLS) {
    const t = tools.find(x => x.name === name);
    if (t && t.inputSchema && t.description) ok(`tool '${name}' present + has inputSchema + description`);
    else bad(`tool '${name}' missing or incomplete schema`);
  }

  // 3. per-tool minimal valid call -> structured non-error result
  const callMap = { 10: "audit", 11: "detect_agents", 12: "find_misplaced", 13: "recommend" };
  for (const [id, name] of Object.entries(callMap)) {
    const r = byId.get(Number(id));
    const txt = r?.result?.content?.[0]?.text;
    if (r?.result && Array.isArray(r.result.content) && typeof txt === "string" && txt.length > 0 && !r.result.isError) {
      ok(`call '${name}' -> valid text result (${txt.length} chars)`);
    } else {
      bad(`call '${name}' -> invalid/error result (${JSON.stringify(r?.result)?.slice(0,120)})`);
    }
  }

  // 4. unknown tool -> JSON-RPC error -32601
  const unk = byId.get(99);
  if (unk?.error?.code === -32601) ok("unknown tool -> error -32601 (proper error handling)");
  else bad(`unknown tool should return -32601 (got ${JSON.stringify(unk)?.slice(0,120)})`);

  console.log(`\n================ RESULT ================`);
  console.log(`  PASS: ${pass}   FAIL: ${fail}`);
  if (fail > 0) { fails.forEach(f => console.log(`    - ${f}`)); process.exit(1); }
  console.log("  MCP server contract verified.");
}

main().catch((e) => { console.error("gauntlet error:", e.message); process.exit(2); });
