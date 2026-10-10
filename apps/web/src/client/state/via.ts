// Which of the site's own links a visitor came from, for a public instance's counters: a landing
// link may carry `?via=<tag>` (VIA_TAGS). The tag stays on this device, in local storage. The server
// only ever gets event names such as `quiz_done_via_x`, the same for everyone who came that way.
// The address bar keeps `via`, so "Open in browser" from an app's own browser carries it along.
import { VIA_TAGS, type ViaTag } from "../../api-types.ts";
import { track, trackOnce } from "./stats.ts";

const VIA_KEY = "abtune.via";
/** A tag counts for this long after the link that set it; a newer link replaces it. */
export const VIA_MS = 7 * 24 * 60 * 60 * 1000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isVia = (x: unknown): x is ViaTag =>
  typeof x === "string" && (VIA_TAGS as readonly string[]).includes(x);

/** The tag in a landing URL's query (`?via=x`), or null for none or one not in VIA_TAGS. */
export function viaOf(search: string): ViaTag | null {
  const raw = new URLSearchParams(search).get("via")?.trim().toLowerCase();
  return isVia(raw) ? raw : null;
}

/**
 * This device's tag at `now`: the URL's, which is remembered (the last link wins), else one
 * remembered less than VIA_MS ago. Without storage, only the URL's counts.
 */
export function currentVia(search: string, now: number, store: Store | null): ViaTag | null {
  const fromUrl = viaOf(search);
  try {
    if (fromUrl) {
      store?.setItem(VIA_KEY, JSON.stringify({ tag: fromUrl, at: now }));
      return fromUrl;
    }
    const saved = JSON.parse(store?.getItem(VIA_KEY) ?? "null") as {
      tag?: unknown;
      at?: unknown;
    } | null;
    if (saved && typeof saved.at === "number" && isVia(saved.tag)) {
      const age = now - saved.at;
      if (age >= 0 && age < VIA_MS) return saved.tag;
    }
    store?.removeItem(VIA_KEY);
  } catch {
    // Unreadable or blocked storage: the URL's tag only.
  }
  return fromUrl;
}

function storage(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** A day this device was on the site with `tag`: `via_<tag>_open`, once per UTC day. */
function countOpen(tag: ViaTag): void {
  trackOnce(`via_${tag}_open`, new Date().toISOString().slice(0, 10));
}

/** This device's tag now, if any, with the day's open counted. */
function openTag(): ViaTag | null {
  const tag = currentVia(location.search, Date.now(), storage());
  if (tag) countOpen(tag);
  return tag;
}

/** On load. */
export function trackVisit(): void {
  openTag();
}

/** The quiz in progress and the tag it started with (one at a time, like the session). */
const QUIZ_KEY = "abtune.via.quiz";

/**
 * A quiz started, and with which tag. The day's open is counted again here (once a day), so a quiz
 * started after midnight UTC on a page opened before it still has its day's open.
 */
export function trackQuizStart(quizSeed: string): void {
  track("quiz_start");
  const tag = openTag();
  if (!tag) return;
  track(`quiz_start_via_${tag}`);
  try {
    storage()?.setItem(QUIZ_KEY, JSON.stringify({ seed: quizSeed, tag }));
  } catch {
    // Without storage the quiz's finish isn't credited to a tag: an undercount, never a double.
  }
}

/**
 * A quiz finished, counted once per quiz seed. It is credited to the tag it started with, and only
 * when its `quiz_done` is counted: a later link that reopens the result credits nothing.
 */
export function trackQuizDone(quizSeed: string): void {
  if (!trackOnce("quiz_done", quizSeed)) return;
  let tag: ViaTag | null = null;
  try {
    const started = JSON.parse(storage()?.getItem(QUIZ_KEY) ?? "null") as {
      seed?: unknown;
      tag?: unknown;
    } | null;
    if (started?.seed === quizSeed && isVia(started.tag)) tag = started.tag;
  } catch {
    // Unreadable: not credited.
  }
  if (!tag) return;
  countOpen(tag);
  track(`quiz_done_via_${tag}`);
}
