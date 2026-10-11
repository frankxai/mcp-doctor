import { appendFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const mode = process.argv[2] ?? "success";
const log = (event) => {
  if (process.env.PROBE_TRACE) appendFileSync(process.env.PROBE_TRACE, `${JSON.stringify({ pid: process.pid, event })}\n`);
};
log("started");
let keepAlive;
process.stdin.on("end", () => {
  log("stdin-ended");
  if (mode === "resistant" || mode === "resistant-silent") return;
  clearInterval(keepAlive);
  process.exit(0);
});
if (mode.startsWith("resistant")) {
  keepAlive = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => log("sigterm-ignored"));
}
if (mode === "exit-0") process.exit(0);
if (mode === "silent" || mode === "resistant-silent") {
  keepAlive ??= setInterval(() => {}, 1000);
  process.stdin.resume();
} else if (mode === "secret-leak" || mode === "stderr-oversize") {
  const arg = process.argv.find((value) => value.startsWith("--token="))?.slice(8) ?? "";
  const secret = process.env.PROBE_SECRET ?? "";
  const modeledKey = ["sk", "ant", "api03"].join("-") + "_" + "X".repeat(48);
  if (mode === "stderr-oversize") writeSync(2, "a".repeat(16384) + secret + arg + "\n");
  else {
    writeSync(2, `first: ${secret.slice(0, 10)}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    writeSync(2, `${secret.slice(10)} ${arg} ${modeledKey}\n`);
  }
  process.exit(1);
} else if (["malformed", "wrong-id", "wrong-id-then-valid", "rpc-error", "unsupported-version", "init-only", "oversize", "ping-error"].includes(mode)) {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    log(request.method);
    if (request.id === undefined) return;
    const reply = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...value }) + "\n");
    if (request.method === "initialize") {
      const result = { protocolVersion: mode === "unsupported-version" ? "1900-01-01" : request.params.protocolVersion, capabilities: {}, serverInfo: { name: "raw-fixture", version: "0.0.0" } };
      if (mode === "malformed") process.stdout.write("not-json\n");
      else if (mode === "oversize") process.stdout.write("x".repeat(1024 * 1024 + 65536) + "\n");
      else if (mode === "rpc-error") reply({ error: { code: -32603, message: process.env.PROBE_RPC_SECRET ?? "fixture RPC failure" } });
      else if (mode.startsWith("wrong-id")) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: `${request.id}-wrong`, result }) + "\n");
        if (mode === "wrong-id-then-valid") reply({ result });
      } else reply({ result });
    } else if (request.method === "ping") {
      if (mode === "ping-error") reply({ error: { code: -32603, message: "fixture ping failure" } });
      else if (mode !== "init-only") reply({ result: {} });
    }
  });
} else {
  process.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      try { log(JSON.parse(line).method); } catch { /* observation only; the SDK owns parsing */ }
    }
  });
  const server = new McpServer({ name: "health-fixture", version: "0.0.0" });
  if (mode === "resources-only") server.resource("fixture", "fixture://health", async () => ({ contents: [{ uri: "fixture://health", text: "ok" }] }));
  if (mode === "tools") server.registerTool("fixture_echo", { description: "Return a controlled fixture response for audit tests.", inputSchema: { value: z.string().optional() } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  if (mode === "env-check" && ["NODE_OPTIONS", "NODE_PATH", "PARENT_CREDENTIAL"].some((key) => process.env[key])) process.exit(42);
  await server.connect(new StdioServerTransport());
}
