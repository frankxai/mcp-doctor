import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { probeStdioServer, StdioProbeError } from "./check-server.js";

export type ProbeRule = "connect" | "unknown-tool" | "bad-args" | "survives";
export interface ProbeFinding {
  tool?: string;
  rule: ProbeRule;
  ok: boolean;
  message: string;
  ms?: number;
}
export interface ProbeReport {
  ok: boolean;
  server?: { name: string; version: string };
  toolCount: number;
  probed: string[];
  skipped: { tool: string; reason: string }[];
  findings: ProbeFinding[];
}

interface ProbeTool {
  name: string;
  inputSchema?: { type?: string; required?: unknown; additionalProperties?: unknown };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export const UNKNOWN_TOOL = "mcp_doctor_probe_unknown_tool";
const EXTRA_KEY = "mcp_doctor_probe_extra";

// Only tools that declare themselves read-only are ever called, and only with input their own
// schema forbids. A server that honours its schema never reaches the tool body.
export function invalidArguments(tool: ProbeTool): { args?: Record<string, unknown>; skip?: string } {
  const a = tool.annotations;
  if (a?.readOnlyHint !== true) return { skip: "not annotated readOnlyHint: true; never called" };
  if (a.destructiveHint === true) return { skip: "annotated destructive; never called" };
  const schema = tool.inputSchema ?? {};
  if (Array.isArray(schema.required) && schema.required.length > 0) return { args: {} };
  if (schema.additionalProperties === false) return { args: { [EXTRA_KEY]: true } };
  return { skip: "schema accepts any object, so no invalid input can be derived" };
}

type Outcome = { kind: "rejected"; detail: string } | { kind: "accepted" } | { kind: "hung" } | { kind: "died" };

async function attempt(client: Client, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<Outcome> {
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    return result.isError === true ? { kind: "rejected", detail: "isError result" } : { kind: "accepted" };
  } catch (error) {
    if (error instanceof McpError) {
      if (error.code === ErrorCode.RequestTimeout) return { kind: "hung" };
      if (error.code === ErrorCode.ConnectionClosed) return { kind: "died" };
      return { kind: "rejected", detail: `JSON-RPC ${error.code}` };
    }
    return { kind: "died" };
  }
}

function judge(rule: ProbeRule, tool: string | undefined, outcome: Outcome, ms: number, what: string): ProbeFinding {
  switch (outcome.kind) {
    case "rejected": return { tool, rule, ok: true, ms, message: `Rejected ${what} (${outcome.detail}).` };
    case "accepted": return { tool, rule, ok: false, ms, message: `Accepted ${what} and returned a success result.` };
    case "hung": return { tool, rule, ok: false, ms, message: `No answer to ${what} within the per-call timeout.` };
    case "died": return { tool, rule, ok: false, ms, message: `The connection dropped while handling ${what}.` };
  }
}

export async function probeServer(command: string, args: string[], options: { timeoutMs?: number; callTimeoutMs?: number } = {}): Promise<ProbeReport> {
  const callTimeoutMs = options.callTimeoutMs ?? 5000;
  try {
    return await probeStdioServer(command, args, async (client) => {
      const { tools } = await client.listTools();
      const info = client.getServerVersion();
      const findings: ProbeFinding[] = [];
      const probed: string[] = [];
      const skipped: { tool: string; reason: string }[] = [];
      const timed = async (rule: ProbeRule, tool: string | undefined, name: string, input: Record<string, unknown>, what: string) => {
        const started = Date.now();
        const outcome = await attempt(client, name, input, callTimeoutMs);
        findings.push(judge(rule, tool, outcome, Date.now() - started, what));
        return outcome.kind !== "died";
      };

      let alive = await timed("unknown-tool", undefined, UNKNOWN_TOOL, {}, "a call to a tool that does not exist");
      for (const tool of tools as ProbeTool[]) {
        if (!alive) break;
        const plan = invalidArguments(tool);
        if (!plan.args) { skipped.push({ tool: tool.name, reason: plan.skip! }); continue; }
        probed.push(tool.name);
        alive = await timed("bad-args", tool.name, tool.name, plan.args, "arguments its own inputSchema forbids");
      }

      let survives = alive;
      if (alive) {
        try { await client.listTools(undefined, { timeout: callTimeoutMs }); } catch { survives = false; }
      }
      findings.push({ rule: "survives", ok: survives, message: survives ? "Still answers tools/list after every probe." : "Stopped answering after the probes." });

      return {
        ok: findings.every((f) => f.ok),
        server: info ? { name: info.name, version: info.version } : undefined,
        toolCount: tools.length,
        probed,
        skipped,
        findings,
      };
    }, { timeoutMs: options.timeoutMs ?? 60000 });
  } catch (error) {
    const message = error instanceof StdioProbeError
      ? error.message + (error.detail ? `\nServer stderr:\n${error.detail}` : "")
      : error instanceof Error ? error.message : "MCP connection failed";
    return { ok: false, toolCount: 0, probed: [], skipped: [], findings: [{ rule: "connect", ok: false, message }] };
  }
}
