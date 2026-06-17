// Validation for the delegation hand-off (docs/DESIGN.md §7).
//
// These checks are the safety boundary at intake: a malformed or mismatched
// hand-off must never become a scheduled task.

import { inputKey, type DelegateForfeitTx, type DelegateIntent } from "../types.ts";

export interface DelegateRequest {
  intent: DelegateIntent;
  forfeitTxs: DelegateForfeitTx[];
  delegatePublicKey: string;
  fee: number;
  /** derived from intent.message `validAt`; passed explicitly for now */
  scheduledAt: number;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** Sanity cap on the service fee (sats). A real deployment tunes this per policy. */
export const MAX_FEE = 1_000_000;

export function validateDelegateRequest(req: DelegateRequest, nowSecs: number): ValidationResult {
  const { intent, forfeitTxs } = req;

  if (!intent) return err("intent is required");
  if (!intent.message) return err("intent.message is required");
  if (!intent.proof) return err("intent.proof is required");
  if (!Array.isArray(intent.inputs) || intent.inputs.length === 0) {
    return err("intent.inputs must be non-empty");
  }
  if (!req.delegatePublicKey) return err("delegatePublicKey is required");
  if (!Number.isFinite(req.fee) || req.fee < 0) return err("fee must be a number >= 0");
  if (req.fee > MAX_FEE) return err(`fee exceeds sanity cap (${MAX_FEE})`);

  // No duplicate inputs within the request.
  const inputKeys = new Set<string>();
  for (const i of intent.inputs) {
    if (!i.txid || !Number.isInteger(i.vout) || i.vout < 0) return err("invalid input");
    const k = inputKey(i);
    if (inputKeys.has(k)) return err(`duplicate input ${k}`);
    inputKeys.add(k);
  }

  // Exactly one forfeit tx per input (set equality between inputs and forfeits).
  if (!Array.isArray(forfeitTxs)) return err("forfeitTxs must be an array");
  const forfeitKeys = new Set<string>();
  for (const f of forfeitTxs) {
    if (!f.forfeitTx) return err("forfeit tx hex required");
    const k = inputKey(f.input);
    if (forfeitKeys.has(k)) return err(`duplicate forfeit tx for input ${k}`);
    if (!inputKeys.has(k)) return err(`forfeit tx for unknown input ${k}`);
    forfeitKeys.add(k);
  }
  if (forfeitKeys.size !== inputKeys.size) {
    return err("each input needs exactly one forfeit tx");
  }

  // Renewal must be scheduled in the future.
  if (!Number.isFinite(req.scheduledAt)) return err("scheduledAt required");
  if (req.scheduledAt <= nowSecs) return err("scheduledAt (validAt) must be in the future");

  return { ok: true };
}

/**
 * Overlap guard (docs/DESIGN.md §5): returns the input keys in `intent` that are
 * already claimed by an active task. A non-empty result means the hand-off must
 * be rejected.
 */
export function overlappingInputs(activeInputKeys: Set<string>, intent: DelegateIntent): string[] {
  return intent.inputs.map(inputKey).filter((k) => activeInputKeys.has(k));
}

function err(error: string): ValidationResult {
  return { ok: false, error };
}
