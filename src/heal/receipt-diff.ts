// Structural summaries for receipts: what moved and which settings it had,
// never the values themselves.
//
// The receipt's diff exists so a human can see what heal did. It does not need
// the config's values, and storing them makes the receipt a credential sink:
// the old diff copied raw config text and then tried to scrub it with two
// heuristics, so any value in a position the heuristics did not recognise
// (an argument after `--connection-string`, a URL query string, a header,
// a nested object) survived in plaintext. This module removes the class of bug
// by construction: every value, wherever it sits, becomes a sha256 reference.
import { sha256Hex } from "./types.js";

export interface ReceiptValueRef {
  /** Dotted path with array indices, e.g. `args[1]` or `env.API_KEY`. */
  path: string;
  type: string;
  sha256: string;
}

export interface ReceiptEntrySummary {
  server: string;
  /** sha256 of this entry's raw registration bytes. */
  sha256: string;
  /** Top-level keys in config order; the useful, non-secret part. */
  keys: string[];
  /** One reference per value, including containers, in document order. */
  values: ReceiptValueRef[];
  /** True when a pathological entry hit the reference cap. */
  truncated?: boolean;
}

/** Bound the work for a pathological entry; a receipt is a summary. */
const MAX_REFS = 200;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function walk(value: unknown, path: string, out: ReceiptValueRef[], state: { truncated: boolean }): void {
  if (out.length >= MAX_REFS) {
    state.truncated = true;
    return;
  }
  const type = typeOf(value);
  const serialized = JSON.stringify(value) ?? String(value);
  out.push({ path: path || ".", type, sha256: sha256Hex(serialized) });
  if (type === "array") {
    (value as unknown[]).forEach((item, index) => walk(item, `${path}[${index}]`, out, state));
  } else if (type === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, path ? `${path}.${key}` : key, out, state);
    }
  }
}

/** Summarize one server registration without exposing any of its values. */
export function summarizeEntry(server: string, rawValue: string, parsed: unknown): ReceiptEntrySummary {
  const values: ReceiptValueRef[] = [];
  const state = { truncated: false };
  walk(parsed, "", values, state);
  const isPlainObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  return {
    server,
    sha256: sha256Hex(rawValue),
    keys: isPlainObject ? Object.keys(parsed as Record<string, unknown>) : [],
    values,
    ...(state.truncated ? { truncated: true } : {}),
  };
}
