// Deterministic pre-image reconstruction (PRD-001 §4.1 vs criterion 3).
//
// §4 forbids secret values in any receipt; criterion 3 requires rollback to
// restore the pre-image byte-for-byte. Storing the verbatim pre-image satisfies
// the second and breaks the first, so the pre-image is *not* stored: the
// receipt keeps a hole-punched template of the exact bytes H1 removed. Every
// non-secret byte of that region (keys, colons, whitespace, commas) is kept;
// each removed value is replaced by one NUL sentinel plus its sha256. At
// rollback the values are read back out of the live config's own
// `quarantined[]` block, where H1 placed them verbatim, and checked against the
// recorded hashes. Reassembly is arithmetic, not inference, and the result is
// verified against the receipt's pre-image sha256 before anything is written.
//
// A raw NUL cannot appear in JSON text outside a string, and inside a string it
// must be escaped as \u0000, so the sentinel is unambiguous.
import {
  SpliceEdit,
  findMember,
  parseObjectAt,
  parseRootObject,
  scanValueEnd,
  sha256Hex,
  skipWs,
} from "./types.js";
export const HOLE = "\u0000";
export const RECONSTRUCTION_VERSION = 1;

export interface ReconstructionHole {
  name: string;
  /** sha256 of the removed value bytes, hex. */
  sha256: string;
}

export interface ReconstructionRemoval {
  /** Start of the removed region in the pre-image. */
  preStart: number;
  /** Removed region bytes, each value replaced by one HOLE sentinel. */
  template: string;
  /** Removed values in file order; one per HOLE. */
  holes: ReconstructionHole[];
}

export interface ReconstructionInsertion {
  /** Offset of the inserted quarantine text in the post-image. */
  postStart: number;
  /** Byte length of the inserted text (its content is never stored). */
  length: number;
}

export interface ReconstructionRecord {
  version: number;
  removals: ReconstructionRemoval[];
  insertion: ReconstructionInsertion;
}

export interface RemovalPlan {
  edit: SpliceEdit;
  removal: ReconstructionRemoval;
}

export interface HoleCandidate {
  name: string;
  valueStart: number;
  valueEnd: number;
}

/**
 * Build one removal edit and its template for a group of adjacent dead members.
 * The group is a contiguous byte range, so every hole lands inside it.
 */
export function planRemoval(text: string, group: { start: number; end: number }, holes: HoleCandidate[]): RemovalPlan {
  const inside = holes
    .filter((hole) => hole.valueStart >= group.start && hole.valueEnd <= group.end)
    .sort((a, b) => a.valueStart - b.valueStart);

  let template = "";
  let cursor = group.start;
  for (const hole of inside) {
    template += text.slice(cursor, hole.valueStart) + HOLE;
    cursor = hole.valueEnd;
  }
  template += text.slice(cursor, group.end);

  return {
    edit: { start: group.start, end: group.end, replacement: "" },
    removal: {
      preStart: group.start,
      template,
      holes: inside.map((hole) => ({ name: hole.name, sha256: sha256Hex(text.slice(hole.valueStart, hole.valueEnd)) })),
    },
  };
}

/** Offset in the post-image of an insertion made at `preOffset`. */
export function mapOffset(preOffset: number, removals: ReconstructionRemoval[], lengths: number[]): number {
  let offset = preOffset;
  for (let i = 0; i < removals.length; i++) {
    const removal = removals[i];
    if (removal.preStart < preOffset) offset += -lengths[i];
  }
  return offset;
}

export interface QuarantinedEntry {
  name: string;
  /** Raw value bytes of the entry's `config` member. */
  rawValue: string;
}

export type ReconstructOutcome = { ok: true; text: string } | { ok: false; refusal: string };

/** Read the live `quarantined[]` block: names plus the raw value bytes H1 kept. */
export function readQuarantinedEntries(text: string): QuarantinedEntry[] {
  const root = parseRootObject(text);
  if (!root) return [];
  const member = findMember(root.members, "quarantined");
  if (!member) return [];
  if (text[skipWs(text, member.valueStart)] !== "[") return [];
  const arrayEnd = scanValueEnd(text, member.valueStart);
  if (arrayEnd === null) return [];

  const entries: QuarantinedEntry[] = [];
  let i = skipWs(text, member.valueStart) + 1;
  while (i < arrayEnd) {
    i = skipWs(text, i);
    if (text[i] === "]") break;
    if (text[i] === ",") {
      i++;
      continue;
    }
    const object = parseObjectAt(text, i);
    if (!object) break;
    const nameMember = findMember(object.members, "name");
    const configMember = findMember(object.members, "config");
    if (nameMember && configMember) {
      try {
        const name = JSON.parse(text.slice(nameMember.valueStart, nameMember.valueEnd));
        if (typeof name === "string") {
          entries.push({ name, rawValue: text.slice(configMember.valueStart, configMember.valueEnd) });
        }
      } catch {
        // A malformed entry simply is not a reconstruction source.
      }
    }
    i = object.end;
  }
  return entries;
}

function filled(removal: ReconstructionRemoval, values: string[]): string {
  const parts = removal.template.split(HOLE);
  if (parts.length !== removal.holes.length + 1) {
    throw new Error("reconstruction template is malformed");
  }
  let out = parts[0];
  for (let i = 0; i < removal.holes.length; i++) out += values[i] + parts[i + 1];
  return out;
}

/**
 * Reassemble the pre-image from the live config.
 * @param liveText      current config bytes (the post-image, or drifted)
 * @param record        receipt reconstruction metadata
 * @param quarantined   entries read from the live config's quarantined[], in file order
 */
export function reconstructPreImage(
  liveText: string,
  record: ReconstructionRecord,
  quarantined: QuarantinedEntry[],
): ReconstructOutcome {
  const used = new Set<number>();
  const values: string[][] = [];

  for (const removal of record.removals) {
    const row: string[] = [];
    for (const hole of removal.holes) {
      const index = quarantined.findIndex((entry, i) => !used.has(i) && entry.name === hole.name);
      if (index === -1) {
        return { ok: false, refusal: `quarantined[] no longer holds ${JSON.stringify(hole.name)}; the pre-image cannot be reconstructed` };
      }
      const entry = quarantined[index];
      if (sha256Hex(entry.rawValue) !== hole.sha256) {
        return { ok: false, refusal: `quarantined[] entry ${JSON.stringify(hole.name)} no longer matches the recorded bytes; refusing a partial restore` };
      }
      used.add(index);
      row.push(entry.rawValue);
    }
    values.push(row);
  }

  // 1. Undo the quarantine insertion (a pure insert, so its length is enough).
  const { postStart, length } = record.insertion;
  if (postStart < 0 || postStart + length > liveText.length) {
    return { ok: false, refusal: "recorded quarantine insertion does not fit the live config; refusing a partial restore" };
  }
  let text = liveText.slice(0, postStart) + liveText.slice(postStart + length);

  // 2. Re-insert the removed regions, highest offset first, at offsets shifted
  //    only by removals that preceded them. `record.removals` is written in
  //    ascending pre-image order by the apply path.
  const ascending = record.removals.map((removal, index) => ({ removal, index }));
  const cutOffsets: number[] = [];
  let removedBefore = 0;
  for (const { removal, index } of ascending) {
    cutOffsets[index] = removal.preStart - removedBefore;
    removedBefore += filledLength(removal, values[index]);
  }
  const descending = [...ascending].sort((a, b) => b.removal.preStart - a.removal.preStart);
  for (const { removal, index } of descending) {
    const body = filled(removal, values[index]);
    const at = cutOffsets[index];
    if (at < 0 || at > text.length) {
      return { ok: false, refusal: "recorded removal offset does not fit the live config; refusing a partial restore" };
    }
    text = text.slice(0, at) + body + text.slice(at);
  }

  return { ok: true, text };
}

function filledLength(removal: ReconstructionRemoval, values: string[]): number {
  return removal.template.length - removal.holes.length + values.reduce((sum, value) => sum + value.length, 0);
}
