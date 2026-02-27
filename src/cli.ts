#!/usr/bin/env node

import {
  scanAllServers,
  findDuplicates,
  findMissingEnvVars,
  findMisplacedConfigs,
} from "./scanner/config-reader.js";
import {
  checkAllServers,
} from "./scanner/health-checker.js";
import { analyzeTiers, generateOnDemandCommands } from "./analyzer/tier-optimizer.js";
import { listPresets, getPreset, generateInstallCommands, PRESETS } from "./analyzer/presets.js";
import {
  formatHeader,
  formatHealthReport,
  formatDuplicates,
  formatTierRecommendations,
  formatSummary,
  formatFixCommands,
  formatMisplacedConfigs,
} from "./reporter/format.js";
import { startMcpServer } from "./mcp-server.js";
import { detectInstalledAgents, scanAllAgents } from "./scanner/multi-agent-reader.js";

const HELP = `
  Usage: mcp-doctor <command> [options]

  Commands:
    audit              Full health check of all MCP servers
    audit --quick      Fast check (config only, no spawning)
    audit --project X  Filter to specific project path
    recommend          Show preset packs for your workflow
    recommend <pack>   Show details for a specific pack
    agents             Detect installed coding agents and their MCP configs
    serve              Run as an MCP server (for agent self-diagnosis)
    help               Show this help message

  Examples:
    npx @frankxai/mcp-doctor audit
    npx @frankxai/mcp-doctor audit --quick
    npx @frankxai/mcp-doctor recommend ai-architect
    npx @frankxai/mcp-doctor agents

  MCP Server Mode:
    claude mcp add mcp-doctor -- npx -y @frankxai/mcp-doctor serve
`;

async function runAudit(args: string[]) {
  const quick = args.includes("--quick");
  const projectIdx = args.indexOf("--project");
  const projectFilter =
    projectIdx !== -1 ? args[projectIdx + 1] : undefined;

  console.log(formatHeader());

  // Scan
  console.log("  Scanning MCP configuration...\n");
  const servers = scanAllServers(projectFilter);

  if (servers.length === 0) {
    console.log(
      "  No MCP servers found. Is Claude Code installed?\n  Expected config at: ~/.claude.json\n"
    );
    return;
  }

  console.log(`  Found ${servers.length} MCP server(s) across all scopes.\n`);

  // Health check
  if (!quick) {
    console.log("  Running health checks (this may take a moment)...\n");
  }
  const healthResults = await checkAllServers(servers, { quick });

  // Duplicates
  const duplicates = findDuplicates(servers);

  // Tier analysis
  const tiers = analyzeTiers(servers, healthResults);
  const toRemove = tiers.filter((t) => t.recommendedTier === "remove");
  const toOnDemand = tiers.filter((t) => t.recommendedTier === "on-demand");

  // Generate on-demand commands for servers that should move
  const onDemandServers = toOnDemand.map((t) => t.server);
  const onDemandCommands = generateOnDemandCommands(onDemandServers);

  // Misplaced config check (the #1 MCP misconfiguration)
  const misplaced = findMisplacedConfigs();

  // Output
  if (misplaced.length > 0) {
    console.log(formatMisplacedConfigs(misplaced));
  }
  console.log(formatHealthReport(healthResults));
  console.log(formatDuplicates(duplicates));
  console.log(formatTierRecommendations(tiers));
  console.log(
    formatSummary(
      servers.length,
      healthResults.filter((r) => r.status === "healthy").length,
      duplicates.size,
      toRemove.length
    )
  );
  console.log(formatFixCommands(toRemove, onDemandCommands));
}

function runRecommend(args: string[]) {
  const packName = args[0];

  console.log(formatHeader());

  if (packName) {
    // Look up by preset key directly, or by matching formatted name
    const preset = PRESETS[packName] || listPresets().find(
      (p) => p.name.toLowerCase().replace(/\s+/g, "-") === packName
    );

    if (!preset) {
      console.log(`  Unknown preset: ${packName}\n`);
      console.log("  Available presets:");
      for (const p of listPresets()) {
        console.log(`    - ${p.name.toLowerCase().replace(/\s+/g, "-")}: ${p.description}`);
      }
      return;
    }

    console.log(`  \x1b[1m${preset.name}\x1b[0m`);
    console.log(`  ${preset.description}\n`);
    console.log("  Servers:");

    for (const server of preset.servers) {
      const tierIcon = server.tier === "always-on" ? "\x1b[32m●\x1b[0m" : "\x1b[33m◐\x1b[0m";
      console.log(`  ${tierIcon} ${server.name} \x1b[90m(${server.tier})\x1b[0m`);
      console.log(`    ${server.why}`);
    }

    console.log("\n  Install commands:");
    const commands = generateInstallCommands(preset);
    for (const cmd of commands) {
      console.log(`  \x1b[36m${cmd}\x1b[0m`);
    }
    console.log("");
    return;
  }

  // List all presets
  console.log("  \x1b[1mAVAILABLE PRESET PACKS\x1b[0m");
  console.log("  " + "─".repeat(50) + "\n");

  const presets = listPresets();
  for (const preset of presets) {
    const key = preset.name.toLowerCase().replace(/\s+/g, "-");
    const alwaysOn = preset.servers.filter((s) => s.tier === "always-on").length;
    const onDemand = preset.servers.filter((s) => s.tier === "on-demand").length;

    console.log(`  \x1b[1m${preset.name}\x1b[0m \x1b[90m(${key})\x1b[0m`);
    console.log(`  ${preset.description}`);
    console.log(
      `  \x1b[32m${alwaysOn} always-on\x1b[0m · \x1b[33m${onDemand} on-demand\x1b[0m\n`
    );
  }

  console.log("  \x1b[90mUsage: npx mcp-doctor recommend <pack-name>\x1b[0m\n");
}

function runAgents() {
  console.log(formatHeader());
  console.log("  Detecting installed coding agents...\n");

  const agents = detectInstalledAgents();

  if (agents.length === 0) {
    console.log("  No coding agents with MCP configs detected.\n");
    return;
  }

  for (const info of agents) {
    const icon = info.serverCount > 0 ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
    console.log(`  ${icon} \x1b[1m${info.agent}\x1b[0m — ${info.serverCount} server(s)`);
    if (info.globalPath) console.log(`    \x1b[90mConfig: ${info.globalPath}\x1b[0m`);
    for (const pp of info.projectPaths) {
      console.log(`    \x1b[90mProject: ${pp}\x1b[0m`);
    }
  }

  const otherAgents = scanAllAgents();
  for (const { agent, servers } of otherAgents) {
    if (servers.length > 0) {
      console.log(`\n  \x1b[1m${agent} servers:\x1b[0m`);
      for (const s of servers) {
        const cmd = s.config.command ? `${s.config.command} ${(s.config.args || []).slice(0, 2).join(" ")}` : s.config.url || "";
        console.log(`    ${s.name} \x1b[90m→ ${cmd}\x1b[0m`);
      }
    }
  }
  console.log("");
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "audit":
      await runAudit(args.slice(1));
      break;
    case "recommend":
      runRecommend(args.slice(1));
      break;
    case "agents":
      runAgents();
      break;
    case "serve":
      startMcpServer();
      return; // serve runs indefinitely
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(formatHeader());
      console.log(HELP);
      break;
    default:
      console.log(`  Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
