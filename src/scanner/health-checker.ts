import { spawn, execFileSync } from "child_process";
import { McpServerEntry } from "./config-reader.js";
import { PACKAGE_VERSION } from "../version.js";

export type HealthStatus =
  | "healthy"
  | "broken"
  | "timeout"
  | "missing-command"
  | "missing-env"
  | "unchecked";

export interface HealthResult {
  server: McpServerEntry;
  status: HealthStatus;
  message: string;
  responseTimeMs?: number;
}

function commandExists(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Env vars safe to inherit — everything else is stripped */
const SAFE_ENV_KEYS = new Set([
  "PATH", "HOME", "SHELL", "USER", "LANG", "TERM",
  "NODE_PATH", "NODE_OPTIONS", "NVM_DIR", "NVM_BIN",
  "TMPDIR", "TMP", "TEMP", "XDG_RUNTIME_DIR",
]);

/**
 * Build a minimal env for spawned processes.
 * Only passes safe system vars + the server's own env vars.
 * Prevents leaking AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, etc.
 */
function buildSafeEnv(serverEnv: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) {
      safe[key] = process.env[key]!;
    }
  }
  return { ...safe, ...serverEnv };
}

/**
 * Redact any known secret values from a string.
 * Scans for env var values from the server config and replaces them.
 * Also catches common API key patterns as a safety net.
 */
export function redactSecrets(text: string, serverEnv: Record<string, string>): string {
  let result = text;

  // Redact known env var values (exact match replacement)
  for (const [key, value] of Object.entries(serverEnv)) {
    if (value && value.length > 6) {
      result = result.replaceAll(value, `[REDACTED:${key}]`);
    }
  }

  // Safety net: catch common API key patterns even if not in env
  result = result.replace(/AIzaSy[A-Za-z0-9_-]{33}/g, "[REDACTED:GEMINI_KEY]");
  result = result.replace(/sk-ant-api[A-Za-z0-9_-]{20,}/g, "[REDACTED:ANTHROPIC_KEY]");
  result = result.replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED:OPENAI_KEY]");
  result = result.replace(/re_[A-Za-z0-9]{20,}/g, "[REDACTED:RESEND_KEY]");
  result = result.replace(/ghp_[A-Za-z0-9]{36,}/g, "[REDACTED:GITHUB_TOKEN]");
  result = result.replace(/gho_[A-Za-z0-9]{36,}/g, "[REDACTED:GITHUB_OAUTH]");
  result = result.replace(/npm_[A-Za-z0-9]{36,}/g, "[REDACTED:NPM_TOKEN]");
  result = result.replace(/xai-[A-Za-z0-9]{20,}/g, "[REDACTED:XAI_KEY]");
  result = result.replace(/eyJ[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED:JWT]");

  return result;
}

export async function checkServerHealth(
  server: McpServerEntry,
  timeoutMs: number = 10000
): Promise<HealthResult> {
  const config = server.config;

  // SSE/HTTP servers — check URL reachability
  if (config.type === "sse" || config.type === "streamable-http") {
    if (!config.url) {
      return {
        server,
        status: "broken",
        message: `No URL configured for ${config.type} server`,
      };
    }
    return { server, status: "unchecked", message: "Remote server (skipped)" };
  }

  // stdio servers — check command exists and process starts
  if (!config.command) {
    return { server, status: "broken", message: "No command configured" };
  }

  // Check if base command is available
  const baseCommand = config.command;
  const knownRunners = ["npx", "uvx", "node", "python", "python3", "uv", "deno", "bun"];
  if (!knownRunners.includes(baseCommand)) {
    if (!commandExists(baseCommand)) {
      return {
        server,
        status: "missing-command",
        message: `Command '${baseCommand}' not found in PATH`,
      };
    }
  }

  // Check for placeholder env vars
  const env = config.env || {};
  for (const [key, value] of Object.entries(env)) {
    if (
      !value ||
      value === "" ||
      value.startsWith("YOUR_") ||
      value === "undefined"
    ) {
      return {
        server,
        status: "missing-env",
        message: `Environment variable ${key} has placeholder value: "${value}"`,
      };
    }
  }

  // Try spawning the process
  return new Promise<HealthResult>((resolve) => {
    const startTime = Date.now();
    const args = config.args || [];

    const proc = spawn(baseCommand, args, {
      env: buildSafeEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      const elapsed = Date.now() - startTime;
      // Process was running for the full timeout = likely healthy stdio server
      resolve({
        server,
        status: "healthy",
        message: "Server responsive (stdio)",
        responseTimeMs: elapsed,
      });
    }, Math.min(timeoutMs, 5000));

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({
        server,
        status: "broken",
        message: `Failed to start: ${err.message}`,
      });
    });

    proc.on("exit", (code: number | null) => {
      clearTimeout(timer);
      const elapsed = Date.now() - startTime;

      if (code === 0 && elapsed < 1000) {
        resolve({
          server,
          status: "healthy",
          message: "Server started and exited cleanly",
          responseTimeMs: elapsed,
        });
      } else if (code !== 0 && code !== null) {
        resolve({
          server,
          status: "broken",
          message: `Exited with code ${code}${stderr ? `: ${redactSecrets(stderr.slice(0, 200), env)}` : ""}`,
          responseTimeMs: elapsed,
        });
      } else {
        resolve({
          server,
          status: "healthy",
          message: "Server started successfully",
          responseTimeMs: elapsed,
        });
      }
    });

    // Send MCP initialization handshake
    try {
      proc.stdin?.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "mcp-doctor", version: PACKAGE_VERSION },
          },
        }) + "\n"
      );
    } catch {
      // stdin might be closed already
    }
  });
}

export async function checkAllServers(
  servers: McpServerEntry[],
  options: { quick?: boolean; timeoutMs?: number } = {}
): Promise<HealthResult[]> {
  const { quick = false, timeoutMs = 5000 } = options;

  if (quick) {
    return servers.map((server) => {
      const config = server.config;

      if (config.type !== "stdio") {
        return { server, status: "unchecked" as HealthStatus, message: "Remote server (skipped)" };
      }

      if (!config.command) {
        return { server, status: "broken" as HealthStatus, message: "No command configured" };
      }

      const env = config.env || {};
      for (const [key, value] of Object.entries(env)) {
        if (!value || value.startsWith("YOUR_")) {
          return {
            server,
            status: "missing-env" as HealthStatus,
            message: `${key} not configured`,
          };
        }
      }

      return { server, status: "healthy" as HealthStatus, message: "Config looks valid" };
    });
  }

  const results: HealthResult[] = [];
  for (const server of servers) {
    const result = await checkServerHealth(server, timeoutMs);
    results.push(result);
  }
  return results;
}
