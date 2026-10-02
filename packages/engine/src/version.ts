import { canonicalJson, sha256Hex } from "./hash.ts";
import type { Bank } from "./types.ts";

/** Keep in sync with packages/engine/package.json (a test enforces it). */
export const ENGINE_SEMVER = "0.2.0";

const bankHashCache = new WeakMap<Bank, string>();

/** First 8 hex chars of sha256 over the canonical bank. Any bank edit changes it. */
export function bankHash(bank: Bank): string {
  let hash = bankHashCache.get(bank);
  if (hash === undefined) {
    hash = sha256Hex(canonicalJson(bank)).slice(0, 8);
    bankHashCache.set(bank, hash);
  }
  return hash;
}

/**
 * The engine version that goes into seeds. It includes the bank hash: editing a question's
 * effects changes profiles, so the same answers must not keep the same seed.
 */
export function engineVersion(bank: Bank): string {
  return `${ENGINE_SEMVER}+bank.${bankHash(bank)}`;
}
