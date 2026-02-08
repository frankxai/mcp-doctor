export interface PresetPack {
  name: string;
  description: string;
  servers: PresetServer[];
}

export interface PresetServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  tier: "always-on" | "on-demand";
  why: string;
}

export const PRESETS: Record<string, PresetPack> = {
  "web-developer": {
    name: "Web Developer",
    description: "Full-stack web development with Next.js, Vercel, and testing",
    servers: [
      {
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp"],
        tier: "always-on",
        why: "Testing, scraping, browser automation for web development",
      },
      {
        name: "memory",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        tier: "always-on",
        why: "Persistent knowledge graph for project context across sessions",
      },
      {
        name: "sequential-thinking",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        tier: "on-demand",
        why: "Structured reasoning for architecture decisions and complex debugging",
      },
    ],
  },

  "content-creator": {
    name: "Content Creator",
    description: "Blogging, social media, image generation, and email",
    servers: [
      {
        name: "nanobanana",
        command: "uvx",
        args: ["nanobanana-mcp-server@latest"],
        env: { GEMINI_API_KEY: "<your-gemini-api-key>" },
        tier: "always-on",
        why: "AI image generation for blog posts, social media, and products",
      },
      {
        name: "memory",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        tier: "always-on",
        why: "Remember brand voice, content calendar, and editorial decisions",
      },
      {
        name: "resend",
        command: "npx",
        args: ["-y", "resend-mcp"],
        env: { RESEND_API_KEY: "<your-resend-api-key>" },
        tier: "on-demand",
        why: "Send newsletters and transactional emails directly from sessions",
      },
    ],
  },

  "data-engineer": {
    name: "Data Engineer",
    description: "Databases, APIs, and data pipeline development",
    servers: [
      {
        name: "memory",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        tier: "always-on",
        why: "Track schema decisions, pipeline configs, and query patterns",
      },
      {
        name: "sequential-thinking",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        tier: "always-on",
        why: "Complex query optimization and pipeline architecture reasoning",
      },
      {
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp"],
        tier: "on-demand",
        why: "Scraping data sources, testing dashboards, API exploration",
      },
    ],
  },

  "music-producer": {
    name: "Music Producer",
    description: "AI music creation, lyrics, and audio production",
    servers: [
      {
        name: "memory",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        tier: "always-on",
        why: "Remember song ideas, genre preferences, and production notes",
      },
      {
        name: "nanobanana",
        command: "uvx",
        args: ["nanobanana-mcp-server@latest"],
        env: { GEMINI_API_KEY: "<your-gemini-api-key>" },
        tier: "on-demand",
        why: "Generate album art and visual assets for releases",
      },
      {
        name: "sequential-thinking",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        tier: "on-demand",
        why: "Plan complex arrangements and multi-track production workflows",
      },
    ],
  },

  "ai-architect": {
    name: "AI Architect",
    description: "Building AI systems, agents, and multi-model orchestration",
    servers: [
      {
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp"],
        tier: "always-on",
        why: "Testing AI interfaces, scraping docs, validating outputs",
      },
      {
        name: "memory",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        tier: "always-on",
        why: "Track architecture decisions, model configs, and system patterns",
      },
      {
        name: "sequential-thinking",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        tier: "always-on",
        why: "Multi-step reasoning for agent design and system architecture",
      },
      {
        name: "browser-use",
        command: "uvx",
        args: ["--from", "browser-use[cli]", "browser-use", "--mcp"],
        tier: "on-demand",
        why: "Visual browser agent for testing AI UIs and design tools like v0.dev",
      },
    ],
  },

  devops: {
    name: "DevOps",
    description: "CI/CD, infrastructure, containers, and deployment automation",
    servers: [
      {
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp"],
        tier: "always-on",
        why: "Testing deployment UIs, monitoring dashboards, and smoke tests",
      },
      {
        name: "memory",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        tier: "always-on",
        why: "Track infrastructure configs, deployment history, and runbook decisions",
      },
      {
        name: "sequential-thinking",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        tier: "on-demand",
        why: "Reason through complex deployment strategies and incident response",
      },
    ],
  },

  "mobile-dev": {
    name: "Mobile Developer",
    description: "React Native, Flutter, or native iOS/Android development",
    servers: [
      {
        name: "memory",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        tier: "always-on",
        why: "Track device-specific quirks, API versions, and platform decisions",
      },
      {
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp"],
        tier: "on-demand",
        why: "Test mobile web views, responsive layouts, and API endpoints",
      },
      {
        name: "sequential-thinking",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        tier: "on-demand",
        why: "Plan navigation flows and state management architecture",
      },
    ],
  },

  researcher: {
    name: "Researcher",
    description: "Academic research, technical writing, and knowledge management",
    servers: [
      {
        name: "memory",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        tier: "always-on",
        why: "Build a persistent knowledge graph of sources, findings, and connections",
      },
      {
        name: "sequential-thinking",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        tier: "always-on",
        why: "Structured reasoning for literature review and hypothesis development",
      },
      {
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp"],
        tier: "on-demand",
        why: "Scrape research papers, documentation sites, and data sources",
      },
    ],
  },

  security: {
    name: "Security Engineer",
    description: "Security auditing, penetration testing, and compliance",
    servers: [
      {
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp"],
        tier: "always-on",
        why: "Test web app security, inspect headers, validate auth flows",
      },
      {
        name: "memory",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        tier: "always-on",
        why: "Track vulnerabilities found, remediation status, and compliance requirements",
      },
      {
        name: "sequential-thinking",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        tier: "on-demand",
        why: "Reason through attack vectors and threat modeling scenarios",
      },
    ],
  },

  minimal: {
    name: "Minimal",
    description: "Just the essentials — start clean, add what you need",
    servers: [
      {
        name: "memory",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        tier: "always-on",
        why: "The one MCP every Claude Code user should have — persistent context",
      },
    ],
  },
};

export function getPreset(name: string): PresetPack | undefined {
  return PRESETS[name];
}

export function listPresets(): PresetPack[] {
  return Object.values(PRESETS);
}

export function generateInstallCommands(preset: PresetPack): string[] {
  const commands: string[] = [];

  for (const server of preset.servers) {
    const envFlags = server.env
      ? Object.entries(server.env)
          .map(([k, v]) => `-e ${k}=${v}`)
          .join(" ")
      : "";

    const cmd = `claude mcp add ${server.name}${envFlags ? " " + envFlags : ""} -- ${server.command} ${server.args.join(" ")}`;
    commands.push(cmd);
  }

  return commands;
}
