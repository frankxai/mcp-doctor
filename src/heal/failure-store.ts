// H1 failure history: the durable half of the "fails check 3 consecutive times"
// precondition (PRD-001 §3, H1 row).
//
// Three probes inside one invocation are one observation, not three, and
// `heal --plan` must write zero bytes, so neither surface may accumulate the
// count itself. It lives out of band, in a store only the `audit` path writes
// (one increment per invocation, never more), and both `--plan` and `--apply`
// read. Plan and apply therefore cannot disagree about the same config.
//
// Location: ~/.mcp-doctor/failure-history.json (mode 0600, never inside a repo,
// never beside a project config). Keys are (config path, scope, project path,
// server name) plus a hash of the server's own registration bytes, so editing
// an unrelated server does not reset the history of a dead one.
//
// Contents are counts, ids, timestamps, status classes and hashes only. Probe
// messages can quote a command line or an env value, so no message is stored.
import { mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { sha256Hex, writeArtifact } from "./types.js";

/** PRD-001 §3: H1 fires after this many consecutive failed checks. */
export const FAILURES_REQUIRED = 3;

/** Two counted failures must be at least this far apart; a burst is one blip. */
export const DEFAULT_MIN_FAILURE_INTERVAL_MS = 60_000;

/** Test-only override; still requires distinct invocations. */
export const MIN_INTERVAL_ENV = "MCP_DOCTOR_HEAL_MIN_INTERVAL_MS";

const STORE_DIR = ".mcp-doctor";
const STORE_FILE = "failure-history.json";
const STORE_VERSION = 1;
const STORE_MODE = 0o600;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 500;

export type ProbeStatus = "healthy" | "broken" | "timeout" | "missing-command" | "missing-env" | "unchecked";

/** A failure class that means the server is gone, not merely slow. */
const DEAD_STATUSES: ProbeStatus[] = ["missing-command", "broken"];

export interface FailureRecord {
  server: string;
  scope: string;
  projectPath?: string;
  configPath: string;
  /** sha256 of this server's own registration bytes, not of the whole file. */
  configHash: string;
  consecutiveFailures: number;
  firstFailureAt: string;
  lastFailureAt: string;
  lastStatus: ProbeStatus;
  /** Identity of the check run that produced the last counted failure. */
  run: string;
}

export interface FailureStore {
  version: number;
  records: { [identity: string]: FailureRecord };
}

export interface ObservedEntry {
  name: string;
  scope: string;
  projectPath?: string;
  rawValue: string;
  status: ProbeStatus;
}

export interface RecordOptions {
  configPath: string;
  entries: ObservedEntry[];
  home?: string;
  now?: number;
  intervalMs?: number;
  runId?: string;
}

export function failureStorePath(home: string = homedir()): string {
  return join(home, STORE_DIR, STORE_FILE);
}

/** Identity is human-readable on purpose; it is a JSON key, never a path. */
export function serverIdentity(configPath: string, scope: string, name: string, projectPath?: string): string {
  return `${configPath}\u0000${scope}\u0000${projectPath ?? ""}\u0000${name}`;
}

export function configHashFor(rawValue: string): string {
  return sha256Hex(rawValue);
}

export function minFailureIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MIN_INTERVAL_ENV];
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_MIN_FAILURE_INTERVAL_MS;
}

function emptyStore(): FailureStore {
  return { version: STORE_VERSION, records: {} };
}

/** Never throws: a missing or malformed store reads as empty history. */
export function readFailureStore(home: string = homedir()): FailureStore {
  const path = failureStorePath(home);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as FailureStore;
    if (!parsed || typeof parsed !== "object" || typeof parsed.records !== "object" || parsed.records === null) {
      return emptyStore();
    }
    return { version: STORE_VERSION, records: parsed.records };
  } catch {
    return emptyStore();
  }
}

/** Counted failures for this exact registration; a changed config starts over. */
export function failureCountFor(store: FailureStore, configPath: string, scope: string, name: string, projectPath: string | undefined, configHash: string): number {
  const record = store.records[serverIdentity(configPath, scope, name, projectPath)];
  if (!record || record.configHash !== configHash) return 0;
  return Math.max(0, record.consecutiveFailures);
}

function prune(store: FailureStore, now: number): void {
  const entries = Object.entries(store.records);
  for (const [identity, record] of entries) {
    const at = Date.parse(record.lastFailureAt);
    if (!Number.isFinite(at) || now - at > MAX_AGE_MS) delete store.records[identity];
  }
  const remaining = Object.entries(store.records);
  if (remaining.length <= MAX_RECORDS) return;
  remaining
    .sort((a, b) => Date.parse(b[1].lastFailureAt) - Date.parse(a[1].lastFailureAt))
    .slice(MAX_RECORDS)
    .forEach(([identity]) => delete store.records[identity]);
}

/**
 * Record one check run (one `audit` invocation) against the store.
 *
 * - `healthy` resets the count to zero and forgets the record.
 * - `missing-command` / `broken` increment it, at most once per run id, and
 *   only when at least `intervalMs` has passed since the last counted failure.
 * - `timeout`, `missing-env` and `unchecked` are not evidence either way: they
 *   neither increment nor reset, so a slow server is never quarantined.
 */
export function recordCheckRun(options: RecordOptions): FailureStore {
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now();
  const intervalMs = options.intervalMs ?? minFailureIntervalMs();
  const runId = options.runId ?? `${process.pid}-${now}`;
  const store = readFailureStore(home);
  let changed = false;

  for (const entry of options.entries) {
    const identity = serverIdentity(options.configPath, entry.scope, entry.name, entry.projectPath);
    const hash = configHashFor(entry.rawValue);
    const existing = store.records[identity];

    if (entry.status === "healthy") {
      if (existing) {
        delete store.records[identity];
        changed = true;
      }
      continue;
    }
    if (!DEAD_STATUSES.includes(entry.status)) continue;

    // A different registration is a different server: start its history over.
    const base = existing && existing.configHash === hash ? existing : undefined;
    const count = base?.consecutiveFailures ?? 0;
    if (base && base.run === runId) continue; // one run counts once
    if (count > 0) {
      const since = now - Date.parse(base!.lastFailureAt);
      if (!Number.isFinite(since) || since < intervalMs) continue;
    }
    store.records[identity] = {
      server: entry.name,
      scope: entry.scope,
      ...(entry.projectPath !== undefined ? { projectPath: entry.projectPath } : {}),
      configPath: options.configPath,
      configHash: hash,
      consecutiveFailures: count + 1,
      firstFailureAt: count > 0 ? base!.firstFailureAt : new Date(now).toISOString(),
      lastFailureAt: new Date(now).toISOString(),
      lastStatus: entry.status,
      run: runId,
    };
    changed = true;
  }

  if (changed) {
    prune(store, now);
    const path = failureStorePath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeArtifact(path, JSON.stringify(store, null, 2), STORE_MODE);
  }
  return store;
}
