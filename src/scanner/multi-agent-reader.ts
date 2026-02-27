/**
 * Multi-agent MCP config reader.
 * Reads MCP server configs from Claude Code, Cursor, Cline, Windsurf, and VS Code.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { McpServerConfig, McpServerEntry } from "./config-reader.js";

export type AgentType = "claude-code" | "cursor" | "cline" | "windsurf" | "vscode";

export interface AgentConfigInfo {
  agent: AgentType;
  globalPath: string | null;
  projectPaths: string[];
  serverCount: number;
}

function getAppDataPath(): string {
  const p = platform();
  if (p === "win32") return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  if (p === "darwin") return join(homedir(), "Library", "Application Support");
  return join(homedir(), ".config");
}

/** Get config file paths for each agent */
function getAgentPaths(agent: AgentType): { global: string[]; project: string[] } {
  const home = homedir();
  const appData = getAppDataPath();

  switch (agent) {
    case "claude-code":
      return {
        global: [join(home, ".claude.json")],
        project: [".mcp.json"],
      };

    case "cursor":
      return {
        global: [join(home, ".cursor", "mcp.json")],
        project: [join(".cursor", "mcp.json")],
      };

    case "cline":
      return {
        global: [
          join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
          join(home, ".cline", "data", "settings", "cline_mcp_settings.json"),
        ],
        project: [],
      };

    case "windsurf":
      return {
        global: [join(home, ".codeium", "windsurf", "mcp_config.json")],
        project: [],
      };

    case "vscode":
      return {
        global: [join(appData, "Code", "User", "mcp.json")],
        project: [join(".vscode", "mcp.json")],
      };
  }
}

/**
 * Parse a config file and extract MCP servers.
 * Handles the VS Code difference (uses "servers" key instead of "mcpServers").
 */
function parseConfigFile(
  filePath: string,
  agent: AgentType,
  scope: McpServerEntry["scope"],
  projectPath?: string
): McpServerEntry[] {
  if (!existsSync(filePath)) return [];

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const entries: McpServerEntry[] = [];

    // VS Code uses "servers", everyone else uses "mcpServers"
    const serversKey = agent === "vscode" ? "servers" : "mcpServers";
    const serversObj = parsed[serversKey] as Record<string, Record<string, unknown>> | undefined;

    if (!serversObj || typeof serversObj !== "object") return [];

    for (const [name, rawConfig] of Object.entries(serversObj)) {
      const config = normalizeServerConfig(rawConfig, agent);
      entries.push({
        name,
        config,
        scope,
        projectPath,
      });
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Normalize server config differences between agents.
 * Windsurf uses "serverUrl" for SSE, VS Code requires explicit "type", etc.
 */
function normalizeServerConfig(
  raw: Record<string, unknown>,
  agent: AgentType
): McpServerConfig {
  const config: McpServerConfig = {
    type: "stdio",
    command: raw.command as string | undefined,
    args: raw.args as string[] | undefined,
    env: raw.env as Record<string, string> | undefined,
    url: raw.url as string | undefined,
  };

  // Windsurf uses "serverUrl" for SSE
  if (agent === "windsurf" && raw.serverUrl) {
    config.url = raw.serverUrl as string;
    config.type = "sse";
  }

  // VS Code has explicit type field
  if (raw.type === "sse") config.type = "sse";
  if (raw.type === "http" || raw.type === "streamable-http") config.type = "streamable-http";

  // Infer type from fields if not explicit
  if (!raw.type && config.url && !config.command) {
    config.type = "sse";
  }

  return config;
}

/**
 * Scan a single agent's MCP servers.
 */
export function scanAgentServers(agent: AgentType): McpServerEntry[] {
  // Claude Code has its own complex reader (projects, nested scopes)
  // This function handles the simpler agents
  if (agent === "claude-code") return []; // Use scanAllServers() from config-reader.ts

  const paths = getAgentPaths(agent);
  const servers: McpServerEntry[] = [];

  // Global configs
  for (const globalPath of paths.global) {
    const entries = parseConfigFile(globalPath, agent, "user");
    servers.push(...entries);
  }

  // Project configs (relative to cwd)
  for (const relPath of paths.project) {
    const fullPath = join(process.cwd(), relPath);
    const entries = parseConfigFile(fullPath, agent, "project-local", process.cwd());
    servers.push(...entries);
  }

  return servers;
}

/**
 * Detect which agents are installed on this system.
 */
export function detectInstalledAgents(): AgentConfigInfo[] {
  const agents: AgentType[] = ["claude-code", "cursor", "cline", "windsurf", "vscode"];
  const results: AgentConfigInfo[] = [];

  for (const agent of agents) {
    const paths = getAgentPaths(agent);
    let globalPath: string | null = null;
    let serverCount = 0;
    const projectPaths: string[] = [];

    // Check global config
    for (const gp of paths.global) {
      if (existsSync(gp)) {
        globalPath = gp;
        const servers = parseConfigFile(gp, agent, "user");
        serverCount += servers.length;
        break;
      }
    }

    // Check project configs
    for (const relPath of paths.project) {
      const fullPath = join(process.cwd(), relPath);
      if (existsSync(fullPath)) {
        projectPaths.push(fullPath);
        const servers = parseConfigFile(fullPath, agent, "project-local", process.cwd());
        serverCount += servers.length;
      }
    }

    if (globalPath || projectPaths.length > 0) {
      results.push({ agent, globalPath, projectPaths, serverCount });
    }
  }

  return results;
}

/**
 * Scan ALL agents' MCP servers at once.
 * Returns servers tagged with their source agent.
 */
export function scanAllAgents(): { agent: AgentType; servers: McpServerEntry[] }[] {
  const agents: AgentType[] = ["cursor", "cline", "windsurf", "vscode"];
  const results: { agent: AgentType; servers: McpServerEntry[] }[] = [];

  for (const agent of agents) {
    const servers = scanAgentServers(agent);
    if (servers.length > 0) {
      results.push({ agent, servers });
    }
  }

  return results;
}
