import {
  type AnswerEvent,
  type Bank,
  foldProfile,
  type Hint,
  hintKey,
  profileHints,
  tasteVector,
} from "@abtune/engine";

/** Hints start after the 3-question hook. */
export const HINT_AFTER = 3;
/** A hint that became true within this many answers is shown first. */
const FRESH_WINDOW = 2;
/** Otherwise the current hints take turns, each for this many answers. */
const ROTATE_EVERY = 2;

const hintsAt = (bank: Bank, log: readonly AnswerEvent[]) =>
  profileHints(bank.dimensions, tasteVector(bank, foldProfile(bank, log)));

/**
 * The live hint for a quiz in progress (HANDOFF §4.2): a hint that just became true, else the
 * current hints in turn so the chip keeps moving. A pure function of the log, so Back undoes it.
 */
export function liveHint(bank: Bank, log: readonly AnswerEvent[]): Hint | null {
  const answered = log.filter((e) => e.choice !== "skip").length;
  if (answered < HINT_AFTER) return null;
  const now = hintsAt(bank, log);
  if (now.length === 0) return null;
  const nowKeys = new Set(now.map(hintKey));
  let after = now;
  for (let k = log.length - 1; k >= Math.max(0, log.length - FRESH_WINDOW); k--) {
    const beforeHints = hintsAt(bank, log.slice(0, k));
    const before = new Set(beforeHints.map(hintKey));
    const fresh = after.find((h) => !before.has(hintKey(h)) && nowKeys.has(hintKey(h)));
    if (fresh) return fresh;
    after = beforeHints;
  }
  return now[Math.floor(answered / ROTATE_EVERY) % now.length] ?? null;
}
