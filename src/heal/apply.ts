// heal --apply: execute the plan's H1 rung on ~/.claude.json.
//
// The mutation is surgical: dead members are cut out with exactly one adjacent
// comma, siblings keep their original bytes, and a root `quarantined[]` block
// receives each dead entry with its raw value bytes embedded verbatim.
//
// Artifacts follow PRD-001 §4.1: receipts under .mcp-doctor/heal/ carry only
// hashes and a redacted diff; byte-exact pre-images live in the user's home at
// .mcp-doctor/pre-images/ with mode 0600, outside every repository. §4.2: the
// pre-image and the receipt are persisted first (temp file plus rename); the
// config is written last, so a crash can never strand a mutation the receipts
// cannot explain.
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { redactArgSecrets, redactSecrets } from "../checker/check-server.js";
import {
  HealPlanItem,
  HealPlan,
  HealReceipt,
  coalesceMemberSpans,
  findMember,
  healDirFor,
  groupRemovalSpan,
  parseRootObject,
  preImagePathFor,
  quarantineEntryText,
  scanValueEnd,
  sha256Hex,
  skipWs,
  spliceAll,
  SpliceEdit,
  writeArtifact,
  bold,
  dim,
  green,
  ruler,
} from "./types.js";
import { planFromText, readClaudeConfigText } from "./plan.js";

export interface ApplyResult {
  applied: number;
  configPath: string;
  preImageSha256: string;
  postImageSha256: string;
  receiptIds: string[];
}

const NAME_SANITIZE = /[^a-z0-9._-]+/gi;
const PRE_IMAGE_MODE = 0o600;

/** Deterministic: f(pre-image bytes, server name, rung) — never the clock. */
export function receiptIdFor(preImage: string, name: string, rung: string): string {
  const digest = sha256Hex(`${rung}\u0000${name}\u0000${preImage}`).slice(0, 16);
  const safe = name.replace(NAME_SANITIZE, "-").slice(0, 48) || "server";
  return `${rung.toLowerCase()}-${safe}-${digest}`;
}

/** Removal edits for every dead member, one per run of adjacent dead
 *  siblings, so no two edits ever claim the same comma (PRD review FIX 3). */
export function buildRemovals(text: string, items: HealPlanItem[]): SpliceEdit[] {
  const groups = coalesceMemberSpans(
    text,
    items.map((item) => ({ start: item.span.memberStart, end: item.span.valueEnd })),
  );
  return groups.map((group) => {
    const span = groupRemovalSpan(text, group);
    return { start: span.start, end: span.end, replacement: "" };
  });
}

export function buildQuarantineInsertions(text: string, items: HealPlanItem[]): SpliceEdit[] {
  const entriesText = items
    .map((item) => quarantineEntryText(item.source.name, text.slice(item.span.valueStart, item.span.valueEnd), item.reason))
    .join(",");

  const root = parseRootObject(text);
  if (!root) throw new Error("config root is no longer an object"); // planFromText pre-validated
  const existing = findMember(root.members, "quarantined");

  if (existing) {
    if (text[skipWs(text, existing.valueStart)] !== "[") {
      throw new Error("existing quarantined value is not an array; refusing to touch it");
    }
    const valueEnd = scanValueEnd(text, existing.valueStart);
    if (valueEnd === null) throw new Error("existing quarantined array is malformed");
    const inner = text.slice(existing.valueStart + 1, valueEnd - 1);
    const isEmpty = !/\S/.test(inner);
    return [{
      start: valueEnd - 1,
      end: valueEnd - 1,
      replacement: (isEmpty ? "" : ",") + entriesText,
    }];
  }
  return [{
    start: root.start + 1,
    end: root.start + 1,
    replacement: `"quarantined":[` + entriesText + `]` + (root.members.length > 0 ? "," : ""),
  }];
}

function validatePostImage(newText: string, items: HealPlanItem[]): void {
  const parsed = JSON.parse(newText) as {
    mcpServers?: Record<string, unknown>;
    projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    quarantined?: Array<{ name?: string }>;
  };
  const pools = [parsed.mcpServers ?? {}, ...Object.values(parsed.projects ?? {}).map((p) => p.mcpServers ?? {})];
  for (const item of items) {
    for (const pool of pools) {
      if (Object.prototype.hasOwnProperty.call(pool, item.source.name)) {
        throw new Error(`post-image validation failed: ${item.source.name} is still active`);
      }
    }
    if (!(parsed.quarantined ?? []).some((q) => q.name === item.source.name)) {
      throw new Error(`post-image validation failed: ${item.source.name} missing from quarantined[]`);
    }
  }
}

function unionEnvAndArgs(items: HealPlanItem[]): { env: Record<string, string>; args: string[] } {
  const env: Record<string, string> = {};
  const args: string[] = [];
  for (const item of items) {
    const config = item.source.config as { env?: Record<string, unknown>; args?: unknown[] } | null;
    if (config && typeof config === "object") {
      if (config.env && typeof config.env === "object") {
        for (const [key, value] of Object.entries(config.env as Record<string, unknown>)) {
          if (typeof value === "string") env[key] = value;
        }
      }
      if (Array.isArray(config.args)) {
        for (const arg of config.args) if (typeof arg === "string") args.push(arg);
      }
    }
  }
  return { env, args };
}

export async function applyHeal(configPathOverride?: string): Promise<ApplyResult & { plan: HealPlan }> {
  // §4.3: with --config the named file is the only target and nothing is
  // resolved from the environment.
  const location = readClaudeConfigText(configPathOverride);
  if (!location) {
    return { applied: 0, configPath: "", preImageSha256: "", postImageSha256: "", receiptIds: [], plan: { items: [], skipped: [] } };
  }
  const { configPath, text } = location;
  const plan = await planFromText(text, configPath);
  if (plan.items.length === 0) {
    return { applied: 0, configPath, preImageSha256: sha256Hex(text), postImageSha256: sha256Hex(text), receiptIds: [], plan };
  }

  const newText = spliceAll(text, [
    ...buildRemovals(text, plan.items),
    ...buildQuarantineInsertions(text, plan.items),
  ]);
  validatePostImage(newText, plan.items);

  const preImageSha256 = sha256Hex(text);
  const postImageSha256 = sha256Hex(newText);
  const receiptDir = healDirFor(configPath);
  const { env, args } = unionEnvAndArgs(plan.items);
  const redact = (value: string) => redactArgSecrets(redactSecrets(value, env), args);

  // §4.2: persist receipt and pre-image atomically, THEN mutate the config.
  mkdirSync(receiptDir, { recursive: true });
  const receiptIds: string[] = [];
  for (const item of plan.items) {
    const id = receiptIdFor(text, item.source.name, item.rung);
    const preImagePath = preImagePathFor(homedir(), id);
    mkdirSync(dirname(preImagePath), { recursive: true });
    writeArtifact(preImagePath, text, PRE_IMAGE_MODE);
    const receipt: HealReceipt = {
      id,
      rung: item.rung,
      server: item.source.name,
      configPath,
      preImageSha256,
      postImageSha256,
      diff: {
        removedEntries: [redact(text.slice(item.span.memberStart, item.span.valueEnd))],
        quarantinedEntries: [
          redact(quarantineEntryText(item.source.name, text.slice(item.span.valueStart, item.span.valueEnd), item.reason)),
        ],
      },
      preImagePath,
    };
    writeArtifact(join(receiptDir, `${id}.json`), JSON.stringify(receipt, null, 2));
    receiptIds.push(id);
  }

  // The config moves last: a crash after the receipts still leaves an honest
  // trail (live sha != post sha, so rollback refuses without --force).
  writeFileSync(configPath, newText, "utf8");

  return { applied: plan.items.length, configPath, preImageSha256, postImageSha256, receiptIds, plan };
}

export function formatApply(result: ApplyResult, plan: HealPlan): string {
  const lines: string[] = [bold("\n  HEAL — APPLY"), ruler()];

  if (!result.configPath) {
    lines.push(dim("  No MCP config found; nothing to heal."));
    return lines.join("\n") + "\n";
  }

  // §4.3: the resolved path is printed as the literal first line by the CLI;
  // it is not repeated here.
  if (result.applied === 0) {
    lines.push(`  ${green("0 repairs applied.")} ${dim("Already healed.")}`);
    return lines.join("\n") + "\n";
  }

  for (const item of plan.items) {
    lines.push(`  ${green("✓")} ${item.rung} quarantined ${bold(item.source.name)} ${dim(`→ quarantined[]`)}`);
  }
  for (const id of result.receiptIds) {
    lines.push(`      ${dim(`receipt: ${join(healDirFor(result.configPath), id + ".json")}`)}`);
    lines.push(`      ${dim(`pre-image store: ${preImagePathFor(homedir(), id)} (0600)`)}`);
  }
  lines.push(`      ${dim(`pre-image  sha256: ${result.preImageSha256}`)}`);
  lines.push(`      ${dim(`post-image sha256: ${result.postImageSha256}`)}`);
  lines.push("");
  lines.push(`  ${result.applied} repair(s) applied · ${plan.skipped.length} entr${plan.skipped.length === 1 ? "y" : "ies"} left for a human`);
  lines.push("");
  return lines.join("\n");
}
