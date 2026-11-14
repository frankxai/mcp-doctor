#!/usr/bin/env node

import {
  scanAllServers,
  findDuplicates,
  findMisplacedConfigs,
} from "./scanner/config-reader.js";
import {
  checkAllServers,
  redactArgSecrets,
  redactSecrets,
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
import { checkServer, inspectServer } from "./checker/check-server.js";
import { scoreTools } from "./checker/score.js";
import { detectInstalledAgents, scanAllAgents } from "./scanner/multi-agent-reader.js";
import { formatPlan, planHeal, readClaudeConfigText, scanHealTargets } from "./heal/plan.js";
import { applyHeal, formatApply } from "./heal/apply.js";
import { formatRollback, rollbackHeal } from "./heal/rollback.js";
import { recordCheckRun, serverIdentity } from "./heal/failure-store.js";
// The verb table the MCP `modes` tool serves is also rendered into the CLI
// help below (PRD-005 criterion 5): one source, two surfaces, no drift.
import { DOCTOR_VERBS } from "./heal/modes.js";
import { getClaudeConfigPath } from "./scanner/config-reader.js";
import { resolve } from "path";
import { existsSync } from "fs";

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
    check -- <cmd>     Spawn a stdio MCP server, lint its tools, exit 1 on violations
    check --json -- <cmd>  Same, JSON report on stdout (for CI)
    score -- <cmd>     Grade a server's tool surface against best-in-class practice
    score --json --min 70 -- <cmd>  JSON report; exit 1 below the minimum percent
    score --prefix sis -- <cmd>     Grade names against a brand prefix other than the server name
    heal --plan        List proposed repairs without writing anything. H1 fires
                       only after 3 consecutive failed 'audit' runs (history is
                       kept in ~/.mcp-doctor/failure-history.json, counts only)
    heal --apply       Execute safe repairs (quarantine dead servers), write receipts
    heal --rollback <id>  Rebuild and restore the pre-image from the receipt and quarantined[]
                       (--force discards intervening changes; it refuses if the
                       reconstruction cannot be proven byte-exact)
    heal --config <path>  Target an explicit config file for every scope (plan, apply, rollback);
                       --apply with --config counts as confirmed, no --yes needed
    heal --apply --yes Confirm writing the live profile (~/.claude.json) resolved from the home
                       directory; without --yes or --config, apply exits 3 and writes nothing
    help               Show this help message

  Examples:
    npx @frankxai/mcp-doctor audit
    npx @frankxai/mcp-doctor audit --quick
    npx @frankxai/mcp-doctor recommend ai-architect
    npx @frankxai/mcp-doctor agents
    npx @frankxai/mcp-doctor check --json -- node dist/server.js

  MCP Server Mode:
    claude mcp add mcp-doctor -- npx -y @frankxai/mcp-doctor serve
`;

/**
 * The MCP verb table, rendered for a terminal reader. PRD-005 criterion 5 keeps
 * this section and mcp_doctor_modes' response on one list: the table in
 * src/heal/modes.ts is the single source, so editing it changes both surfaces
 * with the next build. The surrounding help prose stays by hand — flags like
 * --force and --yes say more than the table's write classes do.
 */
function verbTableHelp(): string {
  const width = Math.max(...DOCTOR_VERBS.map((row) => row.verb.length));
  const lines = [
    "",
    "  MCP verbs (the same table mcp_doctor_modes serves):",
    "",
  ];
  for (const row of DOCTOR_VERBS) {
    lines.push(`    ${row.verb.padEnd(width)}  ${row.mapsTo}  [${row.writeClass}]`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Record one audit's probe outcomes into the durable H1 failure history
 * (PRD-001 §3 H1). This is the only writer: `heal --plan` must write nothing,
 * and a count that lives inside one invocation is not evidence of anything.
 * Only servers the heal ladder can actually edit (Claude user/project entries)
 * are recorded, and only status classes are stored.
 */
function recordAuditHistory(
  servers: ReturnType<typeof scanAllServers>,
  healthResults: Awaited<ReturnType<typeof checkAllServers>>
): void {
  const location = readClaudeConfigText();
  if (!location || servers.length !== healthResults.length) return;
  const rawValues = new Map<string, string>();
  for (const target of scanHealTargets(location.text, location.configPath)) {
    rawValues.set(
      serverIdentity(location.configPath, target.scope, target.name, target.projectPath),
      location.text.slice(target.span.valueStart, target.span.valueEnd)
    );
  }

  const entries = servers.flatMap((server, i) => {
    if (server.scope !== "user" && server.scope !== "project-local") return [];
    const rawValue = rawValues.get(serverIdentity(location.configPath, server.scope, server.name, server.projectPath));
    if (rawValue === undefined) return [];
    return [
      {
        name: server.name,
        scope: server.scope,
        ...(server.projectPath !== undefined ? { projectPath: server.projectPath } : {}),
        rawValue,
        status: healthResults[i].status,
      },
    ];
  });
  if (entries.length === 0) return;
  // History is advisory: a home directory that refuses the write must never
  // make the audit itself fail.
  try {
    recordCheckRun({ configPath: location.configPath, entries });
  } catch {
    // no history this run; the next audit retries
  }
}

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
  // H1's precondition is recorded here and read by heal; one invocation counts
  // at most once, whatever the probe count inside it.
  if (!quick) recordAuditHistory(servers, healthResults);

  // Duplicates
  const duplicates = findDuplicates(servers);

  // Tier analysis
  const tiers = analyzeTiers(servers, healthResults);
  const toRemove = tiers.filter((t) => t.recommendedTier === "remove");
  const toOnDemand = tiers.filter((t) => t.recommendedTier === "on-demand");

  // Generate on-demand commands for servers that should move
  const onDemandServers = toOnDemand.map((t) => t.server);
  const onDemandCommands = generateOnDemandCommands(onDemandServers);
  for (const server of onDemandServers) {
    const command = onDemandCommands.get(server.name);
    if (command) onDemandCommands.set(server.name, redactArgSecrets(redactSecrets(command, server.config.env ?? {}), server.config.args ?? []));
  }

  // Misplaced config check (the #1 MCP misconfiguration)
  const misplaced = findMisplacedConfigs();

  // Output
  if (misplaced.length > 0) {
    console.log(formatMisplacedConfigs(misplaced));
  }
  console.log(formatHealthReport(healthResults));
  console.log(formatDuplicates(duplicates));
  console.log(formatTierRecommendations(tiers));

  const verifiedCount = quick ? 0 : healthResults.filter((r) => r.responseTimeMs !== undefined).length;
  console.log(
    formatSummary(
      servers.length,
      healthResults.filter((r) => r.status === "healthy").length,
      duplicates.size,
      toRemove.length,
      verifiedCount
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

async function runScore(args: string[]): Promise<number> {
  const split = args.indexOf("--");
  const target = split === -1 ? [] : args.slice(split + 1);
  const flags = split === -1 ? args : args.slice(0, split);
  const minIndex = flags.indexOf("--min");
  const min = minIndex === -1 ? 0 : Number(flags[minIndex + 1]);
  const prefixIndex = flags.indexOf("--prefix");
  const prefix = prefixIndex === -1 ? undefined : flags[prefixIndex + 1];
  const badPrefix = prefixIndex !== -1 && !/^[a-z][a-z0-9_-]{0,40}$/i.test(prefix ?? "");
  if (target.length === 0 || !Number.isFinite(min) || min < 0 || min > 100 || badPrefix) {
    console.error("  Usage: mcp-doctor score [--json] [--min <0-100>] [--prefix <service>] -- <command> [args...]");
    return 1;
  }
  let inspected;
  try {
    inspected = await inspectServer(target[0], target.slice(1));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (flags.includes("--json")) console.log(JSON.stringify({ error: message }));
    else console.error(`  Could not start the server: ${message}`);
    return 1;
  }
  const report = scoreTools(inspected.tools, inspected.server?.name ?? target.join(" "), prefix);
  if (flags.includes("--json")) {
    console.log(JSON.stringify({ server: inspected.server, toolCount: inspected.tools.length, ...report }, null, 2));
  } else {
    const label = inspected.server ? `${inspected.server.name}@${inspected.server.version}` : target.join(" ");
    console.log(`  ${label} — ${inspected.tools.length} tool(s) — score ${report.points}/${report.max} (${report.percent}%)\n`);
    for (const item of report.criteria) {
      const mark = item.points === 2 ? "\x1b[32m●●\x1b[0m" : item.points === 1 ? "\x1b[33m●○\x1b[0m" : "\x1b[31m○○\x1b[0m";
      console.log(`  ${mark} ${item.label}`);
      if (item.points < 2) {
        const shown = item.failing.slice(0, 5).join(", ");
        console.log(`       ${item.failing.length} tool(s): ${shown}${item.failing.length > 5 ? ", ..." : ""}`);
        console.log(`       \x1b[90m${item.advice}\x1b[0m`);
      }
    }
    console.log("\n  Also check by hand:");
    for (const line of report.manual) console.log(`  - ${line}`);
  }
  return inspected.tools.length === 0 || report.percent < min ? 1 : 0;
}

async function runCheck(args: string[]): Promise<number> {
  const split = args.indexOf("--");
  const target = split === -1 ? [] : args.slice(split + 1);
  if (target.length === 0) {
    console.error("  Usage: mcp-doctor check [--json] -- <command> [args...]");
    return 1;
  }
  const report = await checkServer(target[0], target.slice(1));
  if (args.slice(0, split).includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const label = report.server ? `${report.server.name}@${report.server.version}` : target.join(" ");
    console.log(`  ${report.ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${label} — ${report.toolCount} tool(s)`);
    for (const issue of report.issues) {
      console.log(`    [${issue.rule}]${issue.tool ? ` ${issue.tool}:` : ""} ${issue.message}`);
    }
  }
  return report.ok ? 0 : 1;
}

async function runHeal(args: string[]): Promise<number> {
  const rollbackIdx = args.indexOf("--rollback");
  try {
    // §4.3: --config <path> is the explicit target for every scope; nothing is
    // resolved from the environment while it is present. Naming the file is
    // the confirmation, so an explicit target never needs --yes.
    let configOverride: string | undefined;
    const configIdx = args.indexOf("--config");
    if (configIdx !== -1) {
      const value = args[configIdx + 1];
      if (!value || value.startsWith("--")) {
        console.error("  Usage: mcp-doctor heal --config <path> [--plan | --apply | --rollback <id>]");
        return 4;
      }
      configOverride = resolve(value);
    }
    const targetPath = configOverride ?? getClaudeConfigPath();
    const yes = args.includes("--yes");

    if (rollbackIdx !== -1) {
      const id = args[rollbackIdx + 1];
      if (!id || id.startsWith("--")) {
        console.error("  Usage: mcp-doctor heal --rollback <id> [--force]");
        return 4;
      }
      const outcome = rollbackHeal(id, args.includes("--force"), configOverride);
      console.log(formatRollback(outcome));
      return outcome.status === "refused" ? 3 : 0;
    }

    // --plan and --apply point at an existing file when --config names one:
    // refuse instead of creating it.
    if (configOverride !== undefined && !existsSync(configOverride) && (args.includes("--apply") || args.includes("--plan"))) {
      console.error(`  heal: config file not found: ${configOverride}`);
      return 4;
    }

    if (args.includes("--apply")) {
      // Live profile = the path resolved from the ambient home directory, with
      // no --config. Writing it requires --yes; the refusal touches nothing.
      if (configOverride === undefined && !yes) {
        console.error(
          `  heal --apply refused: this would write ${targetPath}. Confirm with --yes, or target an explicit file with --config <path>.`
        );
        return 3;
      }
      console.log(targetPath);
      const result = await applyHeal(configOverride);
      console.log(formatApply(result, result.plan));
      return result.applied > 0 ? 2 : 0;
    }
    if (args.includes("--plan")) {
      console.log(targetPath);
      const location = readClaudeConfigText(configOverride);
      const plan = await planHeal(configOverride);
      console.log(formatPlan(plan, location?.configPath ?? targetPath));
      return plan.items.length > 0 ? 1 : 0;
    }
    console.error("  Usage: mcp-doctor heal --plan | --apply | --rollback <id> [--force] [--config <path>] [--yes]");
    return 4;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  heal failed: ${redactSecrets(message, {})}`);
    return 4;
  }
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
    case "score":
      process.exitCode = await runScore(args.slice(1));
      return;
    case "check":
      process.exitCode = await runCheck(args.slice(1));
      return;
    case "heal":
      process.exitCode = await runHeal(args.slice(1));
      return;
    case "serve":
      startMcpServer();
      return; // serve runs indefinitely
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(formatHeader());
      console.log(HELP + verbTableHelp());
      break;
    default:
      console.log(`  Unknown command: ${command}`);
      console.log(HELP + verbTableHelp());
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
