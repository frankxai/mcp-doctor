import { McpServerEntry } from "./config-reader.js";
import { probeStdioServer, StdioProbeError } from "../checker/check-server.js";
export { redactSecrets, redactArgSecrets } from "../checker/check-server.js";

export type HealthStatus = "healthy" | "broken" | "timeout" | "missing-command" | "missing-env" | "unchecked";
export interface HealthResult {
  server: McpServerEntry;
  status: HealthStatus;
  message: string;
  responseTimeMs?: number;
  /** Redacted local diagnostic only; never include it in MCP results or tier reasons. */
  detail?: string;
}

function configured(server: McpServerEntry): HealthResult | undefined {
  const config = server.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return { server, status: "broken", message: "Invalid server configuration" };
  if (config.type !== undefined && !["stdio", "sse", "streamable-http"].includes(config.type)) return { server, status: "broken", message: "Unsupported transport configuration" };
  if (config.type === "sse" || config.type === "streamable-http") {
    return typeof config.url !== "string" || !config.url ? { server, status: "broken", message: "No remote URL configured" } : { server, status: "unchecked", message: "Remote protocol not tested" };
  }
  if (typeof config.command !== "string" || !config.command) return { server, status: "broken", message: "No command configured" };
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string"))) return { server, status: "broken", message: "Invalid command arguments" };
  if (config.env !== undefined && (typeof config.env !== "object" || config.env === null || Array.isArray(config.env))) return { server, status: "broken", message: "Invalid environment configuration" };
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (typeof value !== "string" || !value || value.startsWith("YOUR_") || value === "undefined") return { server, status: "missing-env", message: `Environment variable ${key} is not configured` };
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
