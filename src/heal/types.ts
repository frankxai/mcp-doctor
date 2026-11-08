// Shared types, output helpers, and the byte-level JSON span anatomy used by
// the heal ladder. Quarantine is a *surgical* edit: locate the raw member span
// in the file, relocate it into a quarantined[] block, and leave every other
// byte of the file untouched.
import { createHash } from "crypto";
import { dirname, join } from "path";
import { chmodSync, renameSync, unlinkSync, writeFileSync } from "fs";

export type RepairRung = "H1";

export type ConfigFileScope = "user" | "project-local";

export interface HealSourceEntry {
  name: string;
  scope: ConfigFileScope;
  configPath: string;
  projectPath?: string;
  config: unknown;
}

export type SkippedClass = "unauthenticated" | "remote-untested" | "transient";

export interface HealPlanItem {
  rung: RepairRung;
  source: HealSourceEntry;
  /** Redacted, human-readable reason; deterministic and stored in the receipt. */
  reason: string;
  /** Diagnostic from the failed probe; printed only, never stored in the config. */
  detail?: string;
  /** Raw byte span of the `"<name>": <value>` member inside the config text. */
  span: MemberSpan;
  parsed: unknown;
}

export interface SkippedEntry {
  source: HealSourceEntry;
  skipClass: SkippedClass;
  message: string;
}

export interface HealPlan {
  items: HealPlanItem[];
  skipped: SkippedEntry[];
}

export interface HealReceipt {
  id: string;
  rung: RepairRung;
  server: string;
  configPath: string;
  preImageSha256: string;
  postImageSha256: string;
  diff: {
    removedEntries: string[];
    quarantinedEntries: string[];
  };
  preImagePath: string;
}

// ---- minimal output vocabulary matching reporter/format.ts style ----
export function bold(text: string): string { return `\x1b[1m${text}\x1b[0m`; }
export function dim(text: string): string { return `\x1b[90m${text}\x1b[0m`; }
export function red(text: string): string { return `\x1b[31m${text}\x1b[0m`; }
export function green(text: string): string { return `\x1b[32m${text}\x1b[0m`; }
export function yellow(text: string): string { return `\x1b[33m${text}\x1b[0m`; }

export function ruler(): string {
  return "  " + "─".repeat(50);
}

// ---- hashing ----
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Receipts and artifacts live next to the config they heal. */
export function healDirFor(configPath: string): string {
  return join(dirname(configPath), ".mcp-doctor", "heal");
}

// Only mcp-doctor may generate receipt ids; refuse anything path-like.
export const RECEIPT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

// ---- byte-level JSON member scanning ----
// The config is pre-validated with JSON.parse before these scanners run, so
// they only ever walk valid JSON and never need to recover from errors.

export interface MemberSpan {
  name: string;
  /** Index of the opening quote of the key. */
  memberStart: number;
  /** Index of the first byte of the value. */
  valueStart: number;
  /** Index one past the last byte of the value (exclusive). */
  valueEnd: number;
}

export interface ObjectSpan {
  start: number;
  end: number; // exclusive
  members: MemberSpan[];
}

export function findMember(members: MemberSpan[], name: string): MemberSpan | undefined {
  return members.find((m) => m.name === name);
}

function isWs(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

export function skipWs(text: string, i: number): number {
  while (i < text.length && isWs(text[i])) i++;
  return i;
}

/** Parse a JSON string literal starting at `i`; returns the decoded name and start/end positions. */
export function parseJsonString(text: string, i: number): { value: string; start: number; end: number } | null {
  if (text[i] !== '"') return null;
  const start = i;
  let out = "";
  i++;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') return { value: out, start, end: i + 1 };
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) return null;
      if (next === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      const mapped = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[next];
      if (mapped === undefined) return null;
      out += mapped;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return null;
}

/** Return the exclusive end of the JSON value starting at `i` (string, number, literal, object, array). */
export function scanValueEnd(text: string, i: number): number | null {
  const ch = text[i];
  if (ch === '"' || ch === "{" || ch === "[") {
    // A string literal parses directly; braces/arrays walk nested structure.
    if (ch === '"') {
      const s = parseJsonString(text, i);
      return s ? s.end : null;
    }
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        const s = parseJsonString(text, i);
        if (!s) return null;
        i = s.end;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return null;
  }
  // number, true, false, null: whitespace/comma/close-brace terminate
  while (i < text.length && !isWs(text[i]) && text[i] !== "," && text[i] !== "}" && text[i] !== "]") i++;
  return i;
}

/** Parse the object whose `{` sits at `i`; lists member spans at this level. */
export function parseObjectAt(text: string, i: number): ObjectSpan | null {
  i = skipWs(text, i);
  if (text[i] !== "{") return null;
  const start = i;
  i++;
  const members: MemberSpan[] = [];
  while (true) {
    i = skipWs(text, i);
    const c = text[i];
    if (c === "}") return { start, end: i + 1, members };
    if (c === ",") { i++; continue; }
    const key = parseJsonString(text, i);
    if (!key) return null;
    i = skipWs(text, key.end);
    if (text[i] !== ":") return null;
    i = skipWs(text, i + 1);
    const valueStart = i;
    const valueEnd = scanValueEnd(text, i);
    if (valueEnd === null) return null;
    members.push({ name: key.value, memberStart: key.start, valueStart, valueEnd });
    i = valueEnd;
  }
}

/** Parse the whole document (leading whitespace tolerated) as an object. */
export function parseRootObject(text: string): ObjectSpan | null {
  return parseObjectAt(text, 0);
}

export interface RawSpan {
  start: number;
  end: number;
}

/**
 * Group raw member spans into contiguous runs of adjacent dead siblings
 * (separated only by one comma and whitespace). Adjacent dead members at the
 * end of an object previously collided over that shared comma; treating them
 * as one run is the fix (PRD review FIX 3). Members separated by a live
 * sibling are never adjacent (the gap byte is not a comma in the same object).
 */
export function coalesceMemberSpans(text: string, spans: RawSpan[]): RawSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const groups: RawSpan[] = [];
  for (const span of sorted) {
    const last = groups[groups.length - 1];
    if (last && isAdjacentSibling(text, last.end, span.start)) {
      last.end = span.end;
    } else {
      groups.push({ ...span });
    }
  }
  return groups;
}

function isAdjacentSibling(text: string, prevEnd: number, nextStart: number): boolean {
  let i = skipWs(text, prevEnd);
  if (text[i] !== ",") return false;
  i = skipWs(text, i + 1);
  return i === nextStart;
}

/** Removal byte range for a group of adjacent dead members: the group text
 *  plus exactly one adjacent comma, first the one after it (a live sibling
 *  follows), else the one before it (the group ends the object). */
export function groupRemovalSpan(text: string, group: RawSpan): { start: number; end: number } {
  const after = skipWs(text, group.end);
  if (text[after] === ",") return { start: group.start, end: after + 1 };
  let before = group.start - 1;
  while (before >= 0 && isWs(text[before])) before--;
  if (before >= 0 && text[before] === ",") return { start: before, end: group.end };
  return { start: group.start, end: group.end };
}

export interface SpliceEdit {
  start: number;
  end: number;
  replacement: string;
}

/** Apply non-overlapping edits against original-text indices, high to low. */
export function spliceAll(text: string, edits: SpliceEdit[]): string {
  let result = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, e.start) + e.replacement + result.slice(e.end);
  }
  return result;
}

/**
 * Quarantine entry text: reuses the raw value bytes verbatim so the stored
 * config is exactly what the author had, never a re-serialized copy.
 */
export function quarantineEntryText(name: string, rawValue: string, reason: string): string {
  return `{"name":${JSON.stringify(name)},"config":${rawValue},"reason":${JSON.stringify(reason)}}`;
}

// ---- artifact persistence (PRD-001 §4.1/§4.2) ----

const PRE_IMAGES_DIR: { section: string; dir: string } = { section: ".mcp-doctor", dir: "pre-images" };

/** Pre-image store lives under the user's home, never inside any repository. */
export function preImagePathFor(home: string, id: string): string {
  return join(home, PRE_IMAGES_DIR.section, PRE_IMAGES_DIR.dir, `${id}.json`);
}

/** Temp file plus rename so a partially-written artifact can never be read. */
export function writeArtifact(path: string, data: string, mode?: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw error;
  }
  if (mode !== undefined) {
    try {
      chmodSync(path, mode);
    } catch {
      // Windows chmod carries only the read-only bit; pre-image secrecy on
      // Windows relies on the profile directory's ACLs. Never fail a repair.
    }
  }
}
