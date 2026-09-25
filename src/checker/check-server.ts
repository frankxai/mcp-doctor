import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../version.js";

export interface ToolLike {
  name: string;
  description?: string;
  inputSchema?: { type?: string };
}

export interface CheckIssue {
  tool?: string;
  rule: "name" | "duplicate" | "description" | "schema" | "connect";
  message: string;
}

export interface CheckReport {
  ok: boolean;
  server?: { name: string; version: string };
  toolCount: number;
  tools: string[];
  issues: CheckIssue[];
}

// Stricter than the MCP spec on purpose: snake_case names survive every client's tool-name rules.
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MIN_DESCRIPTION = 20;

export function lintTools(tools: ToolLike[]): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) {
      issues.push({ tool: tool.name, rule: "name", message: "Tool names must match ^[a-z][a-z0-9_]{0,63}$." });
    }
    if (seen.has(tool.name)) {
      issues.push({ tool: tool.name, rule: "duplicate", message: "Tool name is registered more than once." });
    }
    seen.add(tool.name);
    if ((tool.description ?? "").trim().length < MIN_DESCRIPTION) {
      issues.push({ tool: tool.name, rule: "description", message: `Description is missing or shorter than ${MIN_DESCRIPTION} characters.` });
    }
    if (tool.inputSchema?.type !== "object") {
      issues.push({ tool: tool.name, rule: "schema", message: 'inputSchema.type must be "object".' });
    }
  }
  return issues;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const STDERR_TAIL = 2048;

export async function checkServer(command: string, args: string[], timeoutMs = 15000): Promise<CheckReport> {
  const client = new Client({ name: "mcp-doctor-check", version: VERSION });
  const transport = new StdioClientTransport({ command, args, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
  });
  try {
    await withTimeout(client.connect(transport), timeoutMs);
    const { tools } = await withTimeout(client.listTools(), timeoutMs);
    const info = client.getServerVersion();
    const issues = lintTools(tools);
    return {
      ok: issues.length === 0,
      server: info ? { name: info.name, version: info.version } : undefined,
      toolCount: tools.length,
      tools: tools.map((tool) => tool.name),
      issues,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const tail = stderr.trim();
    return {
      ok: false,
      toolCount: 0,
      tools: [],
      issues: [{ rule: "connect", message: tail ? `${reason}\nServer stderr:\n${tail}` : reason }],
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
