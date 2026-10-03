import { bankIndex } from "./dims.ts";
import type { AnswerEvent } from "./profile.ts";
import type { Bank } from "./types.ts";

/**
 * The answers that may go to the AI layer (HANDOFF §10.4, §13): no skips, nothing the bank doesn't
 * know, and `sensitive` questions only with the per-session opt-in. The browser filters before
 * sending and the server filters again, so neither side alone can leak one.
 */
export function answersForAi(
  bank: Bank,
  log: readonly AnswerEvent[],
  includeSensitive: boolean,
): AnswerEvent[] {
  const { byId } = bankIndex(bank);
  return log.filter((e) => {
    const q = byId.get(e.id);
    return (
      q !== undefined && e.choice !== "skip" && (includeSensitive || q.sensitive === undefined)
    );
  });
}
