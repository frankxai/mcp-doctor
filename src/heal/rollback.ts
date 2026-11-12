// heal --rollback <id>: rebuild and restore the byte-exact pre-image.
//
// Nothing verbatim is stored: the receipt keeps both sha256s plus a hole-punched
// template of removed bytes, and the config's own `quarantined[]` block still
// holds each dead entry exactly as H1 moved it. Rollback reassembles the
// pre-image from those two sources, verifies it against the receipt hash, and
// writes it atomically. A mismatch refuses with exit 3; a partial restore is
// never attempted (PRD-001 §4.1/§4.2, review surfaces B and D).
//
// The receipt is data, not authority: its recorded target path must equal the
// config path this binary resolved before anything is written.
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { getClaudeConfigPath } from "../scanner/config-reader.js";
import { ReconstructionRecord, readQuarantinedEntries, reconstructPreImage } from "./reconstruct.js";
import {
  RECEIPT_ID_PATTERN,
  bold,
  dim,
  green,
  healDirFor,
  red,
  ruler,
  sha256Hex,
  writeArtifact,
  yellow,
} from "./types.js";

export type RollbackStatus = "restored" | "already-restored" | "refused";

export interface RollbackOutcome {
  status: RollbackStatus;
  id: string;
  receiptPath: string;
  configPath: string;
  preImageSha256: string;
  postImageSha256: string;
  liveSha256?: string | null;
  /** Human-readable refusal reason; set exactly when status is "refused". */
  refusal?: string;
  /** True when --force let the rollback proceed over a drifted config. */
  discardedDrift?: boolean;
}

interface ReceiptShape {
  rung?: string;
  server?: string;
  configPath?: string;
  preImageSha256?: string;
  postImageSha256?: string;
  reconstruction?: ReconstructionRecord;
}

export function validateReceiptId(id: string): void {
  if (!RECEIPT_ID_PATTERN.test(id) || id.includes("..")) {
    throw new Error(`not a heal receipt id: ${JSON.stringify(id)}`);
  }
}

function refusing(outcome: Omit<RollbackOutcome, "status" | "refusal">, refusal: string): RollbackOutcome {
  return { status: "refused", ...outcome, refusal };
}

function validReconstruction(value: unknown): value is ReconstructionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as ReconstructionRecord;
  return (
    typeof record.insertion?.postStart === "number" &&
    typeof record.insertion?.length === "number" &&
    Array.isArray(record.removals) &&
    record.removals.every(
      (removal) =>
        typeof removal.preStart === "number" &&
        typeof removal.template === "string" &&
        Array.isArray(removal.holes) &&
        removal.holes.every((hole) => typeof hole.name === "string" && typeof hole.sha256 === "string"),
    )
  );
}

export function rollbackHeal(id: string, force: boolean, configPathOverride?: string): RollbackOutcome {
  validateReceiptId(id);
  // §4.3: with --config the named file is the only target and nothing is
  // resolved from the environment.
  const configPath = configPathOverride ?? getClaudeConfigPath();
  const receiptPath = join(healDirFor(configPath), `${id}.json`);
  if (!existsSync(receiptPath)) {
    throw new Error(`no heal receipt named ${id} under ${healDirFor(configPath)}`);
  }
  let receipt: ReceiptShape;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as ReceiptShape;
  } catch (error) {
    throw new Error(`heal receipt ${id} is not readable JSON: ${(error as Error).message}`);
  }
  if (
    typeof receipt.configPath !== "string" ||
    typeof receipt.preImageSha256 !== "string" ||
    typeof receipt.postImageSha256 !== "string" ||
    receipt.preImageSha256.length === 0 ||
    receipt.postImageSha256.length === 0
  ) {
    throw new Error(`heal receipt ${id} is missing rollback fields`);
  }
  if (!validReconstruction(receipt.reconstruction)) {
    throw new Error(`heal receipt ${id} carries no usable reconstruction record`);
  }
  const base = {
    id,
    receiptPath,
    configPath: receipt.configPath,
    preImageSha256: receipt.preImageSha256,
    postImageSha256: receipt.postImageSha256,
  };

  // §4.2: a planted receipt must not redirect a write.
  if (receipt.configPath !== configPath) {
    return refusing(base, `receipt target ${receipt.configPath} is not the config this binary resolves (${configPath})`);
  }
  if (!existsSync(configPath)) {
    return refusing(base, `config ${configPath} no longer exists; nothing to restore in place`);
  }

  const liveText = readFileSync(configPath, "utf8");
  const liveSha256 = sha256Hex(liveText);
  if (liveSha256 === receipt.preImageSha256) {
    return { status: "already-restored", ...base, liveSha256 };
  }
  const drifted = liveSha256 !== receipt.postImageSha256;
  if (drifted && !force) {
    return refusing(
      { ...base, liveSha256 },
      `live config is not the post-image this receipt produced; rerun with --force to discard intervening changes`,
    );
  }

  const rebuilt = reconstructPreImage(liveText, receipt.reconstruction, readQuarantinedEntries(liveText));
  if (!rebuilt.ok) {
    return refusing({ ...base, liveSha256, ...(drifted ? { discardedDrift: true } : {}) }, rebuilt.refusal);
  }
  if (sha256Hex(rebuilt.text) !== receipt.preImageSha256) {
    return refusing(
      { ...base, liveSha256, ...(drifted ? { discardedDrift: true } : {}) },
      `reconstruction does not match pre-image sha256 ${receipt.preImageSha256}; refusing a partial restore`,
    );
  }

  let mode: number | undefined;
  try {
    mode = statSync(configPath).mode & 0o777;
  } catch {
    mode = undefined;
  }
  writeArtifact(configPath, rebuilt.text, mode);
  return { status: "restored", ...base, liveSha256, ...(drifted ? { discardedDrift: true } : {}) };
}

export function formatRollback(outcome: RollbackOutcome): string {
  const lines = [bold("\n  HEAL — ROLLBACK"), ruler(), dim(`  Receipt: ${outcome.receiptPath}`), ""];
  if (outcome.status === "restored") {
    if (outcome.discardedDrift) {
      lines.push(`  ${yellow("!")} ${dim(`--force discarded intervening changes to ${outcome.configPath}`)}`);
    }
    lines.push(`  ${green("✓")} restored byte-exact pre-image of ${bold(outcome.configPath)}`);
    lines.push(`      ${dim(`sha256: ${outcome.preImageSha256}`)}`);
  } else if (outcome.status === "already-restored") {
    lines.push(`  ${green("✓")} nothing to restore: ${dim("config already matches this receipt's pre-image")}`);
    lines.push(`      ${dim(`sha256: ${outcome.preImageSha256}`)}`);
  } else {
    lines.push(`  ${red("✗ refused")}: ${dim(outcome.refusal ?? "policy refused")}`);
    if (outcome.discardedDrift) {
      lines.push(`      ${dim("--force was given; intervening changes would have been discarded")}`);
    }
    lines.push(`      ${dim(`live  sha256: ${outcome.liveSha256 ?? "(unverified)"}`)}`);
    lines.push(`      ${dim(`post  sha256: ${outcome.postImageSha256}`)}`);
  }
  return lines.join("\n") + "\n";
}
