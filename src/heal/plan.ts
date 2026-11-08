// heal --plan: locate MCP server registrations, decide what the repair ladder
// would do, and print it. A plan never writes: no config bytes, no receipts,
// no state directories.
import { existsSync, readFileSync } from "fs";
import { checkServerHealth } from "../scanner/health-checker.js";
import { redactSecrets } from "../checker/check-server.js";
import { getClaudeConfigPath, McpServerConfig, McpServerEntry } from "../scanner/config-reader.js";
import {
  bold,
  dim,
  findMember,
  green,
  HealPlan,
  HealPlanItem,
  HealSourceEntry,
  MemberSpan,
  ObjectSpan,
  parseObjectAt,
  parseRootObject,
  red,
  ruler,
  SkippedClass,
  SkippedEntry,
  yellow,
} from "./types.js";

export const PROBE_TIMEOUT_MS = 3000;

export interface ScanTarget extends HealSourceEntry {
  span: MemberSpan;
}

/** Collect every `mcpServers` entry in ~/.claude.json with its raw byte span. */
export function scanHealTargets(text: string, configPath: string): ScanTarget[] {
  const root = parseRootObject(text);
  if (!root) return [];
  const targets: ScanTarget[] = [];

  const harvest = (container: ObjectSpan | undefined, scope: "user" | "project-local", projectPath?: string) => {
    if (!container) return;
    for (const member of container.members) {
      targets.push({
        name: member.name,
        scope,
        configPath,
        projectPath,
        config: JSON.parse(text.slice(member.valueStart, member.valueEnd)),
        span: member,
      });
    }
  };

  harvest(decodeMcpServers(text, root), "user");

  const projectsMember = findMember(root.members, "projects");
  if (projectsMember) {
    const projects = parseObjectAt(text, projectsMember.valueStart);
    if (projects) {
      for (const projectMember of projects.members) {
        const projectObj = parseObjectAt(text, projectMember.valueStart);
        if (!projectObj) continue;
        harvest(decodeMcpServers(text, projectObj), "project-local", projectMember.name);
      }
    }
  }
  return targets;
}

function decodeMcpServers(text: string, container: ObjectSpan): ObjectSpan | undefined {
  const member = findMember(container.members, "mcpServers");
  if (!member) return undefined;
  return parseObjectAt(text, member.valueStart) ?? undefined;
}

interface ProbeOutcome {
  dead: boolean;
  skipClass?: SkippedClass;
  skipMessage?: string;
  reason?: string;
  detail?: string;
}

async function evaluateEntry(target: ScanTarget): Promise<ProbeOutcome> {
  const config = target.config as Record<string, unknown> | null;
  const isRemote =
    !!config && (config.type === "sse" || config.type === "streamable-http");
  if (isRemote) {
    return { dead: false, skipClass: "remote-untested", skipMessage: "remote protocol; heal probes stdio only" };
  }

  const serverTarget: McpServerEntry = {
    name: target.name,
    config: target.config as McpServerConfig,
    scope: target.scope,
    ...(target.projectPath !== undefined ? { projectPath: target.projectPath } : {}),
  };
  const result = await checkServerHealth(serverTarget, PROBE_TIMEOUT_MS);

  // H1 fires only on deterministic death (PRD review of S1). missing-command
  // and broken are structural — the same probe fails on every run, no
  // persistence needed. timeout is timing, not death: skipping it keeps
  // three-probe blips from ever disabling a slow-but-alive server (S2 will
  // gate those on persisted failure history).
  if (result.status === "healthy" || result.status === "unchecked") return { dead: false };
  if (result.status === "missing-env") {
    return {
      dead: false,
      skipClass: "unauthenticated",
      skipMessage: result.message,
    };
  }
  if (result.status === "timeout") {
    return {
      dead: false,
      skipClass: "transient",
      skipMessage: "transient: needs failure history (S2)",
    };
  }

  const env = (config && typeof config === "object" && (config as { env?: Record<string, string> }).env) || {};
  const reason = redactSecrets(`MCP check failed (${result.status}): ${result.message}`, env);
  const detail = result.detail ? redactSecrets(result.detail.slice(0, 200), env) : undefined;
  return { dead: true, reason, detail };
}

/** Decide the whole plan, including probes, from one config text snapshot. */
export async function planFromText(text: string, configPath: string): Promise<HealPlan> {
  const plan: HealPlan = { items: [], skipped: [] };
  if (!parseRootObject(text)) {
    throw new Error(`not valid JSON: ${configPath}`);
  }
  for (const target of scanHealTargets(text, configPath)) {
    const outcome = await evaluateEntry(target);
    if (outcome.dead && outcome.reason) {
      const item: HealPlanItem = {
        rung: "H1",
        source: {
          name: target.name,
          scope: target.scope,
          configPath: target.configPath,
          ...(target.projectPath !== undefined ? { projectPath: target.projectPath } : {}),
          config: target.config,
        },
        reason: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        span: target.span,
        parsed: target.config,
      };
      plan.items.push(item);
    } else if (outcome.skipClass) {
      plan.skipped.push({
        source: {
          name: target.name,
          scope: target.scope,
          configPath: target.configPath,
          ...(target.projectPath !== undefined ? { projectPath: target.projectPath } : {}),
          config: target.config,
        },
        skipClass: outcome.skipClass,
        message: outcome.skipMessage ?? "",
      });
    }
  }
  return plan;
}

export interface HealConfigLocation {
  configPath: string;
  text: string;
}

export function readClaudeConfigText(configPathOverride?: string): HealConfigLocation | null {
  // §4.3: with --config the named file is the only target and nothing is
  // resolved from the environment.
  const configPath = configPathOverride ?? getClaudeConfigPath();
  if (!existsSync(configPath)) return null;
  return { configPath, text: readFileSync(configPath, "utf8") };
}

/** heal --plan against the current config on disk. Never writes. */
export async function planHeal(configPathOverride?: string): Promise<HealPlan> {
  const location = readClaudeConfigText(configPathOverride);
  if (!location) return { items: [], skipped: [] };
  return planFromText(location.text, location.configPath);
}

const SCOPE_LABELS: { [scope: string]: string } = {
  user: "user",
  "project-local": "project",
};

export function formatPlan(plan: HealPlan, configPath: string): string {
  const lines: string[] = [bold("\n  HEAL — PLAN"), ruler()];
  // §4.3: the resolved path is printed as the literal first line by the CLI,
  // above any finding; it is not repeated here.
  if (!existsSync(configPath)) {
    lines.push(dim(`  No MCP config found at ${configPath}; nothing to heal.`), "");
    return lines.join("\n");
  }
  lines.push("");

  for (const item of plan.items) {
    const where = dim(`[${SCOPE_LABELS[item.source.scope] ?? item.source.scope}]`);
    lines.push(`  ${red("✗")} ${item.rung} ${bold("QUARANTINE-DEAD")} ${item.source.name} ${where}`);
    lines.push(`      ${dim(item.reason)}`);
    if (item.detail) lines.push(`      ${dim(item.detail)}`);
    lines.push(`      ${dim('proposal: disable the entry and record it under quarantined[]')}`);
  }

  for (const skipper of plan.skipped) {
    const where = skipper.source.projectPath ? dim(` (${skipper.source.projectPath})`) : "";
    lines.push(`  ${yellow("◌")} ${skipper.source.name} ${dim(`[${SCOPE_LABELS[skipper.source.scope] ?? skipper.source.scope}]${where}`)}`);
    lines.push(`      ${dim(`not healed: ${skipper.message}`)}`);
  }

  lines.push("");
  if (plan.items.length === 0) {
    lines.push(`  ${green("0 repairs proposed.")} ${dim(`${plan.skipped.length} entr${plan.skipped.length === 1 ? "y" : "ies"} not automatable.`)}`);
  } else {
    lines.push(
      `  ${bold(`${plan.items.length} repair(s) proposed`)} ${dim(`· ${plan.skipped.length} not automatable · nothing written; run heal --apply`)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
