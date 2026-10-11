import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StringDecoder } from "node:string_decoder";
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

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MIN_DESCRIPTION = 20;
export function lintTools(tools: ToolLike[]): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) issues.push({ tool: tool.name, rule: "name", message: "Tool names must match ^[a-z][a-z0-9_]{0,63}$." });
    if (seen.has(tool.name)) issues.push({ tool: tool.name, rule: "duplicate", message: "Tool name is registered more than once." });
    seen.add(tool.name);
    if ((tool.description ?? "").trim().length < MIN_DESCRIPTION) issues.push({ tool: tool.name, rule: "description", message: `Description is missing or shorter than ${MIN_DESCRIPTION} characters.` });
    if (tool.inputSchema?.type !== "object") issues.push({ tool: tool.name, rule: "schema", message: 'inputSchema.type must be "object".' });
  }
  return issues;
}

const SECRET_FLAG = /token|key|secret|passw|auth|bearer|credential/i;
export function redactArgSecrets(text: string, args: string[]): string {
  let result = text;
  args.forEach((arg, i) => {
    const eq = arg.indexOf("=");
    const value = eq > 0 && SECRET_FLAG.test(arg.slice(0, eq)) ? arg.slice(eq + 1) : i > 0 && SECRET_FLAG.test(args[i - 1]) && args[i - 1].startsWith("-") ? arg : "";
    if (value) result = result.replaceAll(value, "[REDACTED:ARG]");
  });
  return result;
}
export function redactSecrets(text: string, serverEnv: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(serverEnv)) {
    if (value && (value.length > 6 || SECRET_FLAG.test(key))) result = result.replaceAll(value, `[REDACTED:${key}]`);
  }
  return result
    .replace(/AIzaSy[A-Za-z0-9_-]{33}/g, "[REDACTED:GEMINI_KEY]")
    .replace(/sk-ant-api[A-Za-z0-9_-]{20,}/g, "[REDACTED:ANTHROPIC_KEY]")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED:OPENAI_KEY]")
    .replace(/re_[A-Za-z0-9]{20,}/g, "[REDACTED:RESEND_KEY]")
    .replace(/ghp_[A-Za-z0-9]{36,}/g, "[REDACTED:GITHUB_TOKEN]")
    .replace(/gho_[A-Za-z0-9]{36,}/g, "[REDACTED:GITHUB_OAUTH]")
    .replace(/npm_[A-Za-z0-9]{36,}/g, "[REDACTED:NPM_TOKEN]")
    .replace(/xai-[A-Za-z0-9]{20,}/g, "[REDACTED:XAI_KEY]")
    .replace(/eyJ[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED:JWT]");
}

export type ProbeFailure = "timeout" | "missing-command" | "protocol" | "connection" | "cleanup";
export class StdioProbeError extends Error {
  constructor(public readonly kind: ProbeFailure, message: string, public readonly detail?: string) {
    super(message);
    this.name = "StdioProbeError";
  }
}

// Observe only public SDK lifecycle methods. SDK close owns the actual ChildProcess
// and escalates using that handle; a recycled PID must never become a kill target.
class ProbeTransport extends StdioClientTransport {
  ownedPid: number | null = null;
  private closeTask?: Promise<void>;
  override async start(): Promise<void> {
    await super.start();
    this.ownedPid = this.pid;
  }
  override close(): Promise<void> {
    this.closeTask ??= super.close();
    return this.closeTask;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface StdioProbeOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** One deadline for initialization and the caller's RPCs; SDK-owned close plus exit verification. */
export async function probeStdioServer<T>(
  command: string,
  args: string[],
  inspect: (client: Client) => Promise<T>,
  options: StdioProbeOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new StdioProbeError("connection", "Probe timeout must be a positive timer-safe integer");
  const env = options.env ?? {};
  const client = new Client({ name: "mcp-doctor", version: VERSION });
  const transport = new ProbeTransport({ command, args, env, stderr: "pipe", maxBufferSize: 1024 * 1024 });
  const decoder = new StringDecoder("utf8");
  let pending = "", stderr = "", dropping = false;
  const retain = (line: string) => {
    stderr = (stderr + redactArgSecrets(redactSecrets(line, env), args) + "\n").slice(-2048);
  };
  const consume = (text: string) => {
    const fragments = text.split("\n");
    fragments.forEach((fragment, i) => {
      if (!dropping) {
        if (pending.length + fragment.length > 8192) {
          pending = "";
          dropping = true;
          retain("[oversized stderr line omitted]");
        } else pending += fragment;
      }
      if (i < fragments.length - 1) {
        if (!dropping) retain(pending.replace(/\r$/, ""));
        pending = "";
        dropping = false;
      }
    });
  };
  transport.stderr?.on("data", (chunk: Buffer) => consume(decoder.write(chunk)));

  let timer: NodeJS.Timeout | undefined;
  let failure: unknown, failed = false, result: T | undefined;
  const protocolFailure = new Promise<never>((_, reject) => {
    client.onerror = (error) => reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new StdioProbeError("missing-command", "Server command could not be started") : new StdioProbeError("protocol", "MCP protocol exchange failed"));
    transport.stderr?.on("error", () => reject(new StdioProbeError("connection", "Server diagnostic stream failed")));
  });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StdioProbeError("timeout", `MCP probe timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  const work = Promise.resolve().then(async () => {
    await client.connect(transport);
    return inspect(client);
  });
  try { result = await Promise.race([work, deadline, protocolFailure]); }
  catch (error) { failure = error; failed = true; }
  finally { clearTimeout(timer); }

  let closeTimer: NodeJS.Timeout | undefined;
  try {
    const closed = await Promise.race([
      Promise.allSettled([client.close(), transport.close()]),
      new Promise<never>((_, reject) => { closeTimer = setTimeout(() => reject(new Error("cleanup deadline")), 5000); }),
    ]);
    if (closed.some((result) => result.status === "rejected")) throw new Error("SDK close failed");
    const pid = transport.ownedPid;
    if (pid !== null) {
      const until = Date.now() + 750;
      while (alive(pid)) {
        if (Date.now() >= until) throw new Error("child still observable");
        await delay(25);
      }
    }
  } catch { throw new StdioProbeError("cleanup", "Probe cleanup could not be verified"); }
  finally { clearTimeout(closeTimer); }
  consume(decoder.end());
  if (pending && !dropping) retain(pending);
  const detail = stderr.trim() || undefined;
  if (failed) {
    if (failure instanceof StdioProbeError) throw new StdioProbeError(failure.kind, failure.message, detail);
    if ((failure as NodeJS.ErrnoException)?.code === "ENOENT") throw new StdioProbeError("missing-command", "Server command could not be started", detail);
    throw new StdioProbeError("connection", "MCP connection failed", detail);
  }
  return result as T;
}

export interface InspectedServer {
  server?: { name: string; version: string };
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
}
export async function inspectServer(command: string, args: string[], timeoutMs = 15000): Promise<InspectedServer> {
  try {
    return await probeStdioServer(command, args, async (client) => {
      const { tools } = await client.listTools();
      const info = client.getServerVersion();
      return { server: info ? { name: info.name, version: info.version } : undefined, tools };
    }, { timeoutMs });
  } catch (error) {
    if (error instanceof StdioProbeError && error.detail) throw new Error(`${error.message}\nServer stderr:\n${error.detail}`);
    throw error;
  }
}
export async function checkServer(command: string, args: string[], timeoutMs = 15000): Promise<CheckReport> {
  try {
    const { server, tools } = await inspectServer(command, args, timeoutMs);
    const issues = lintTools(tools);
    return { ok: issues.length === 0, server, toolCount: tools.length, tools: tools.map((tool) => tool.name), issues };
  } catch (error) {
    return { ok: false, toolCount: 0, tools: [], issues: [{ rule: "connect", message: error instanceof Error ? error.message : "MCP connection failed" }] };
  }
}
