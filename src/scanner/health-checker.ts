import { McpServerConfig, McpServerEntry } from "./config-reader.js";
import { probeStdioServer, StdioProbeError } from "../checker/check-server.js";
export { redactSecrets, redactArgSecrets } from "../checker/check-server.js";

export type HealthStatus = "healthy" | "broken" | "timeout" | "missing-command" | "missing-env" | "unchecked";

/**
 * A registration that cannot be probed, and why. `misconfigured` is a
 * structural defect (a human must fix the entry); `missing-env` is an
 * unconfigured credential. Neither is evidence that the server is gone, so
 * heal may name them but never quarantine them (review finding 2).
 */
export type ConfigProblem =
  | { kind: "misconfigured"; message: string }
  | { kind: "missing-env"; message: string };

export interface HealthResult {
  server: McpServerEntry;
  status: HealthStatus;
  message: string;
  responseTimeMs?: number;
  /** Redacted local diagnostic only; never include it in MCP results or tier reasons. */
  detail?: string;
  /** Structural classification, when the entry could not be probed at all. */
  problem?: "misconfigured" | "missing-env";
}

/** Pure structural classification of one registration; no probe, no I/O. */
export function configProblem(config: unknown): ConfigProblem | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { kind: "misconfigured", message: "Invalid server configuration" };
  }
  const typed = config as McpServerConfig;
  if (typed.type !== undefined && !["stdio", "sse", "streamable-http"].includes(typed.type)) {
    return { kind: "misconfigured", message: "Unsupported transport configuration" };
  }
  if (typed.type === "sse" || typed.type === "streamable-http") {
    return typeof typed.url !== "string" || !typed.url
      ? { kind: "misconfigured", message: "No remote URL configured" }
      : undefined;
  }
  if (typeof typed.command !== "string" || !typed.command) {
    return { kind: "misconfigured", message: "No command configured" };
  }
  if (typed.args !== undefined && (!Array.isArray(typed.args) || typed.args.some((arg) => typeof arg !== "string"))) {
    return { kind: "misconfigured", message: "Invalid command arguments" };
  }
  if (typed.env !== undefined && (typeof typed.env !== "object" || typed.env === null || Array.isArray(typed.env))) {
    return { kind: "misconfigured", message: "Invalid environment configuration" };
  }
  for (const [key, value] of Object.entries(typed.env ?? {})) {
    if (typeof value !== "string" || !value || value.startsWith("YOUR_") || value === "undefined") {
      return { kind: "missing-env", message: `Environment variable ${key} is not configured` };
    }
  }
  return undefined;
}

function configured(server: McpServerEntry): HealthResult | undefined {
  const problem = configProblem(server.config);
  if (problem) {
    return {
      server,
      status: problem.kind === "missing-env" ? "missing-env" : "broken",
      message: problem.message,
      problem: problem.kind,
    };
  }
  const typed = server.config as McpServerConfig;
  if (typed.type === "sse" || typed.type === "streamable-http") {
    return { server, status: "unchecked", message: "Remote protocol not tested" };
  }
  return undefined;
}

export async function checkServerHealth(server: McpServerEntry, timeoutMs = 10000): Promise<HealthResult> {
  const invalid = configured(server);
  if (invalid) return invalid;
  const start = Date.now();
  try {
    const elapsed = await probeStdioServer(server.config.command!, server.config.args ?? [], async (client) => {
      await client.ping();
      return Date.now() - start;
    }, { timeoutMs, env: server.config.env });
    return { server, status: "healthy", message: "MCP handshake verified", responseTimeMs: elapsed };
  } catch (error) {
    const status = error instanceof StdioProbeError && error.kind === "timeout" ? "timeout" : error instanceof StdioProbeError && error.kind === "missing-command" ? "missing-command" : "broken";
    const message = error instanceof StdioProbeError ? error.message : "MCP probe failed";
    return { server, status, message, responseTimeMs: Date.now() - start, ...(error instanceof StdioProbeError && error.detail ? { detail: error.detail } : {}) };
  }
}

export async function checkAllServers(servers: McpServerEntry[], options: { quick?: boolean; timeoutMs?: number } = {}): Promise<HealthResult[]> {
  if (options.quick) return servers.map((server) => configured(server) ?? { server, status: "unchecked", message: "Configuration checked; runtime not tested" });
  const results: HealthResult[] = [];
  for (const server of servers) results.push(await checkServerHealth(server, options.timeoutMs ?? 5000));
  return results;
}
