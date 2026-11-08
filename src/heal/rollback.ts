// heal --rollback <id>: restore the byte-exact pre-image stored in the
// pre-image store (PRD-001 §4.1/§4.2).
//
// The receipt is data, not authority: its recorded target path must match the
// config path this binary resolves for itself, the pre-image file must exist,
// and its sha256 must match the receipt before anything is written. Deleting
// or corrupting the store makes rollback refuse with exit 3; a partial
// restore is never attempted.
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getClaudeConfigPath } from "../scanner/config-reader.js";
import {
  RECEIPT_ID_PATTERN,
  bold,
  dim,
  green,
  healDirFor,
  red,
  ruler,
  sha256Hex,
} from "./types.js";

export type RollbackStatus = "restored" | "already-restored" | "refused";

export interface RollbackOutcome {
  status: RollbackStatus;
  id: string;
  receiptPath: string;
  preImagePath: string | null;
  configPath: string;
  preImageSha256: string;
  postImageSha256: string;
  liveSha256?: string | null;
  /** Human-readable refusal reason; set exactly when status is "refused". */
  refusal?: string;
}

interface ReceiptShape {
  rung?: string;
  server?: string;
  configPath?: string;
  preImageSha256?: string;
  postImageSha256?: string;
  preImagePath?: string;
}

export function validateReceiptId(id: string): void {
  if (!RECEIPT_ID_PATTERN.test(id) || id.includes("..")) {
    throw new Error(`not a heal receipt id: ${JSON.stringify(id)}`);
  }
}

function refusing(outcome: Omit<RollbackOutcome, "status" | "refusal">, refusal: string): RollbackOutcome {
  return { status: "refused", ...outcome, refusal };
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
    typeof receipt.preImagePath !== "string" ||
    receipt.preImageSha256.length === 0
  ) {
    throw new Error(`heal receipt ${id} is missing rollback fields`);
  }
  const base = {
    id,
    receiptPath,
    preImagePath: receipt.preImagePath,
    configPath: receipt.configPath,
    preImageSha256: receipt.preImageSha256,
    postImageSha256: receipt.postImageSha256,
  };

  // §4.2: a planted receipt must not redirect a write.
  if (receipt.configPath !== configPath) {
    return refusing(base, `receipt target ${receipt.configPath} is not the config this binary resolves (${configPath})`);
  }
  if (!existsSync(receipt.preImagePath)) {
    return refusing(base, `pre-image store is missing ${receipt.preImagePath}; refusing a partial restore`);
  }
  const preImage = readFileSync(receipt.preImagePath, "utf8");
  if (sha256Hex(preImage) !== receipt.preImageSha256) {
    return refusing(base, `pre-image bytes do not match receipt sha256 ${receipt.preImageSha256}; refusing a partial restore`);
  }

  const liveSha256 = existsSync(receipt.configPath) ? sha256Hex(readFileSync(receipt.configPath, "utf8")) : null;
  if (liveSha256 === receipt.preImageSha256) {
    return { status: "already-restored", ...base, liveSha256 };
  }
  if (liveSha256 !== receipt.postImageSha256 && !force) {
    return refusing(
      { ...base, liveSha256 },
      `live config is not the post-image this receipt produced; rerun with --force to overwrite anyway`,
    );
  }

  writeFileSync(receipt.configPath, preImage, "utf8");
  return { status: "restored", ...base, liveSha256 };
}

export function formatRollback(outcome: RollbackOutcome): string {
  const lines = [bold("\n  HEAL — ROLLBACK"), ruler(), dim(`  Receipt: ${outcome.receiptPath}`), ""];
  if (outcome.status === "restored") {
    lines.push(`  ${green("✓")} restored byte-exact pre-image of ${bold(outcome.configPath)}`);
    lines.push(`      ${dim(`sha256: ${outcome.preImageSha256}`)}`);
  } else if (outcome.status === "already-restored") {
    lines.push(`  ${green("✓")} nothing to restore: ${dim("config already matches this receipt's pre-image")}`);
    lines.push(`      ${dim(`sha256: ${outcome.preImageSha256}`)}`);
  } else {
    lines.push(`  ${red("✗ refused")}: ${dim(outcome.refusal ?? "policy refused")}`);
    lines.push(`      ${dim(`live  sha256: ${outcome.liveSha256 ?? "(unverified)"}`)}`);
    lines.push(`      ${dim(`post  sha256: ${outcome.postImageSha256}`)}`);
  }
  return lines.join("\n") + "\n";
}
