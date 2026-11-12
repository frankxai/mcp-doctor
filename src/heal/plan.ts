// heal --plan: locate MCP server registrations, decide what the repair ladder
// would do, and print it. A plan never writes: no config bytes, no receipts,
// no probe output, no history. It reads the durable failure history that
// `audit` records, so `--plan` and `--apply` decide from the same evidence and
// cannot disagree (PRD-001 §3 H1, review surface A).
import { existsSync, readFileSync } from "fs";
import { getClaudeConfigPath } from "../scanner/config-reader.js";
import {
  FAILURES_REQUIRED,
  FailureStore,
  configHashFor,
  failureCountFor,
  readFailureStore,
  serverIdentity,
} from "./failure-store.js";
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
  yellow,
} from "./types.js";

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

export interface PlanOptions {
  home?: string;
  store?: FailureStore;
}

function isRemote(target: ScanTarget): boolean {
  const config = target.config as Record<string, unknown> | null;
  return !!config && (config.type === "sse" || config.type === "streamable-http");
}

/** Structural only: a placeholder env value is a human's job, never a repair. */
function unconfiguredEnv(target: ScanTarget): string | undefined {
  const config = target.config as { env?: Record<string, unknown> } | null;
  for (const [key, value] of Object.entries(config?.env ?? {})) {
    if (typeof value !== "string" || !value || value.startsWith("YOUR_") || value === "undefined") {
      return `Environment variable ${key} is not configured`;
    }
  }
  return undefined;
}

function sourceOf(target: ScanTarget): HealSourceEntry {
  return {
    name: target.name,
    scope: target.scope,
    configPath: target.configPath,
    ...(target.projectPath !== undefined ? { projectPath: target.projectPath } : {}),
    config: target.config,
  };
}

/**
 * Decide the whole plan from one config text snapshot and the recorded check
 * history. No probe: the count *is* the evidence, and it was recorded by
 * separate `audit` invocations over time.
 */
export async function planFromText(text: string, configPath: string, options: PlanOptions = {}): Promise<HealPlan> {
  const plan: HealPlan = { items: [], skipped: [] };
  if (!parseRootObject(text)) {
    throw new Error(`not valid JSON: ${configPath}`);
  }
  const store = options.store ?? readFailureStore(options.home);

  for (const target of scanHealTargets(text, configPath)) {
    if (isRemote(target)) {
      plan.skipped.push({ source: sourceOf(target), skipClass: "remote-untested", message: "remote protocol; heal probes stdio only" });
      continue;
    }

    const rawValue = text.slice(target.span.valueStart, target.span.valueEnd);
    const configHash = configHashFor(rawValue);
    const count = failureCountFor(store, configPath, target.scope, target.name, target.projectPath, configHash);
    const record = store.records[serverIdentity(configPath, target.scope, target.name, target.projectPath)];

    if (count >= FAILURES_REQUIRED && record) {
      const item: HealPlanItem = {
        rung: "H1",
        source: sourceOf(target),
        reason: `MCP check failed (${record.lastStatus}) on ${count} consecutive audit runs; last failure ${record.lastFailureAt}`,
        span: target.span,
        parsed: target.config,
      };
      plan.items.push(item);
      continue;
    }

    if (count > 0 && record) {
      plan.skipped.push({
        source: sourceOf(target),
        skipClass: "transient",
        message: `${count}/${FAILURES_REQUIRED} consecutive failed checks (${record.lastStatus} at ${record.lastFailureAt}); run mcp-doctor audit to record another`,
      });
      continue;
    }

    const missingEnv = unconfiguredEnv(target);
    if (missingEnv) {
      plan.skipped.push({ source: sourceOf(target), skipClass: "unauthenticated", message: missingEnv });
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
export async function planHeal(configPathOverride?: string, options: PlanOptions = {}): Promise<HealPlan> {
  const location = readClaudeConfigText(configPathOverride);
  if (!location) return { items: [], skipped: [] };
  return planFromText(location.text, location.configPath, options);
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
