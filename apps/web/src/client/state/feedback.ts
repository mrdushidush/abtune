// "Is this playlist you?" 👍/👎 (HANDOFF §4.3): stored on this device only, keyed by playlist.

export type Vote = "up" | "down";

export interface FeedbackEntry {
  readonly seed: string;
  readonly catalog_version: string;
  readonly vote: Vote;
  readonly answered: number;
  readonly at: string;
}

const KEY = "abtune.feedback.v1";
const MAX_ENTRIES = 500;

function read(): FeedbackEntry[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as FeedbackEntry[]) : [];
  } catch {
    return [];
  }
}

export function voteFor(seed: string): Vote | null {
  return read().find((e) => e.seed === seed)?.vote ?? null;
}

export function recordVote(entry: Omit<FeedbackEntry, "at">): void {
  try {
    const rest = read().filter((e) => e.seed !== entry.seed);
    const next = [...rest, { ...entry, at: new Date().toISOString() }].slice(-MAX_ENTRIES);
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the vote just isn't remembered.
  }
}
