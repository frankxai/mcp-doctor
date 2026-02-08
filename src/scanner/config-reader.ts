import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface McpServerConfig {
  type: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  scope: "user" | "project-local" | "mcp-json" | "claude-ai";
  projectPath?: string;
}

export interface ClaudeConfig {
  mcpServers?: Record<string, McpServerConfig>;
  projects?: Record<
    string,
    {
      mcpServers?: Record<string, McpServerConfig>;
    }
  >;
}

export function getClaudeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

export function readClaudeConfig(): ClaudeConfig | null {
  const configPath = getClaudeConfigPath();
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as ClaudeConfig;
  } catch {
    return null;
  }
}

export function findMcpJsonFiles(startDir?: string): string[] {
  const dirs = startDir ? [startDir] : [process.cwd()];
  const found: string[] = [];

  for (const dir of dirs) {
    const mcpJsonPath = join(dir, ".mcp.json");
    if (existsSync(mcpJsonPath)) {
      found.push(mcpJsonPath);
    }
  }

  return found;
}

export function scanAllServers(projectFilter?: string): McpServerEntry[] {
  const config = readClaudeConfig();
  if (!config) return [];

  const servers: McpServerEntry[] = [];

  // 1. User-scope (global) servers
  if (config.mcpServers) {
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      servers.push({
        name,
        config: serverConfig,
        scope: "user",
      });
    }
  }

  // 2. Project-local servers
  if (config.projects) {
    for (const [projectPath, projectConfig] of Object.entries(
      config.projects
    )) {
      if (projectFilter && !projectPath.includes(projectFilter)) continue;

      if (projectConfig.mcpServers) {
        for (const [name, serverConfig] of Object.entries(
          projectConfig.mcpServers
        )) {
          servers.push({
            name,
            config: serverConfig,
            scope: "project-local",
            projectPath,
          });
        }
      }
    }
  }

  // 3. .mcp.json files in current directory
  const mcpJsonFiles = findMcpJsonFiles();
  for (const filePath of mcpJsonFiles) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const mcpJson = JSON.parse(raw) as {
        mcpServers?: Record<string, McpServerConfig>;
      };
      if (mcpJson.mcpServers) {
        for (const [name, serverConfig] of Object.entries(
          mcpJson.mcpServers
        )) {
          servers.push({
            name,
            config: serverConfig,
            scope: "mcp-json",
            projectPath: filePath,
          });
        }
      }
    } catch {
      // skip malformed .mcp.json
    }
  }

  return servers;
}

export function findDuplicates(
  servers: McpServerEntry[]
): Map<string, McpServerEntry[]> {
  const byName = new Map<string, McpServerEntry[]>();

  for (const server of servers) {
    const existing = byName.get(server.name) || [];
    existing.push(server);
    byName.set(server.name, existing);
  }

  const duplicates = new Map<string, McpServerEntry[]>();
  for (const [name, entries] of byName) {
    if (entries.length > 1) {
      duplicates.set(name, entries);
    }
  }

  return duplicates;
}

export function findMissingEnvVars(servers: McpServerEntry[]): McpServerEntry[] {
  const suspicious: McpServerEntry[] = [];

  for (const server of servers) {
    const env = server.config.env || {};
    for (const [key, value] of Object.entries(env)) {
      if (
        !value ||
        value === "" ||
        value.startsWith("YOUR_") ||
        value === "undefined"
      ) {
        suspicious.push(server);
        break;
      }
    }
  }

  return suspicious;
}
