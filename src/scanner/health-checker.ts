import { spawn, execFileSync } from "child_process";
import { McpServerEntry } from "./config-reader.js";

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
      env: { ...process.env, ...env },
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
          message: `Exited with code ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ""}`,
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
            clientInfo: { name: "mcp-doctor", version: "0.1.0" },
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
