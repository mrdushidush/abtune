import { canonicalJson, sha256Hex } from "./hash.ts";
import type { AnswerEvent } from "./profile.ts";

export interface SeedInput {
  readonly answer_log: readonly AnswerEvent[];
  readonly mode: number;
  readonly length: number;
  readonly packs: readonly string[];
  readonly catalog_version: string;
  readonly engine_version: string;
  readonly seed_salt: number;
}

/**
 * HANDOFF §9.5: seed = sha256(canonical_json(inputs)), first 8 bytes as 16 hex chars.
 * Packs are sorted so their order in a config never matters.
 */
export function computeSeed(input: SeedInput): string {
  const canonical = canonicalJson({
    answer_log: input.answer_log.map((e) => ({ choice: e.choice, id: e.id })),
    catalog_version: input.catalog_version,
    engine_version: input.engine_version,
    length: input.length,
    mode: input.mode,
    packs: [...input.packs].sort(),
    seed_salt: input.seed_salt,
  });
  return sha256Hex(canonical).slice(0, 16);
}

/** Short form for UI ("seed 9f3a…"). */
export function shortSeed(seed: string): string {
  return seed.slice(0, 4);
}
