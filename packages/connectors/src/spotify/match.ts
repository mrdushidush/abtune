// Catalog song → Spotify track (HANDOFF §11.1): ISRC search first, then a title + artist search
// accepted only on title similarity ≥ 0.85 (with the same numbers) and a matching artist.
import type { SpotifyClient, SpotifyTrack } from "./client.ts";
import { SEARCH_LIMIT_MAX } from "./client.ts";

export interface MatchTarget {
  readonly title: string;
  readonly artist: string;
  readonly isrcs: readonly string[];
}

export interface Matched {
  readonly uri: string;
  readonly name: string;
  readonly artists: readonly string[];
  readonly via: "isrc" | "search";
}

/** ISRCs tried per song (a recording can carry many; each try is one call). */
export const MAX_ISRC_TRIES = 3;
/** Normalized title similarity a text-search result needs. */
export const TITLE_MIN = 0.85;

// The catalog's version noise (catalog `build/songs.ts`, `strip_version`), so "Song - 2011
// Remaster" and "Song (feat. X)" compare equal to "Song".
const NOISE = String.raw`re-?master(?:ed)?|live|feat\.?|featuring|ft\.?|radio edit|radio version|radio mix|single version|single edit|album version|mono|stereo|explicit|clean|bonus track|original mix|\d{4} version|\d{4} mix`;
const BRACKETED = new RegExp(String.raw`\s*[([][^)\]]*\b(?:${NOISE})\b[^)\]]*[)\]]`, "gi");
const DASHED = new RegExp(String.raw`\s+[-–—]\s+[^-–—]*\b(?:${NOISE})\b.*$`, "i");
const FEAT = /\s+(?:feat\.?|ft\.|featuring)\s.*$/i;
const LIVE = /[([][^)\]]*\blive\b|\s[-–—]\s[^-–—]*\blive\b/i;
/** Separators inside an artist credit. */
const CREDIT_SPLIT =
  /\s*(?:,|;|\/|&|\+|\band\b|\bfeat\.?|\bft\.|\bfeaturing\b|\bwith\b|\bvs\.?)\s*/i;

/** Lowercase, accents (and Hebrew points) dropped, letters and digits only. */
export function normText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export const stripVersion = (s: string) =>
  s.replace(BRACKETED, "").replace(DASHED, "").replace(FEAT, "");

export const normTitle = (s: string) => normText(stripVersion(s)) || normText(s) || s.toLowerCase();

export const isLive = (title: string) => LIVE.test(title);

/** The numbers in a normalized string: "symphony no 5" and "symphony no 9" must not match. */
const numbers = (s: string) => (s.match(/\p{N}+/gu) ?? []).join(" ");

/** Near-equal normalized strings: similarity ≥ `TITLE_MIN` and the same numbers. */
export const close = (a: string, b: string) =>
  numbers(a) === numbers(b) && similarity(a, b) >= TITLE_MIN;

/** 1 − Levenshtein distance / longer length, over code points. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const x = [...a];
  const y = [...b];
  if (x.length === 0 || y.length === 0) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = cur;
  }
  return 1 - (prev[y.length] as number) / Math.max(x.length, y.length);
}

const artistKey = (s: string) => normText(s).replace(/^the /, "");

/** The whole credit and each credited name ("A & B feat. C" → "a b c", "a", "b", "c"). */
export function creditNames(credit: string): string[] {
  const keys = new Set<string>();
  for (const s of [credit, ...credit.split(CREDIT_SPLIT)]) {
    const k = artistKey(s);
    if (k) keys.add(k);
  }
  return [...keys];
}

export function artistMatches(credit: string, spotifyArtists: readonly string[]): boolean {
  const names = creditNames(credit);
  return spotifyArtists.some((a) => {
    const k = artistKey(a);
    return !!k && names.some((n) => n === k || close(n, k));
  });
}

/** The best text-search result for `t`, or null when none passes the §11.1 checks. */
export function pickBest(t: MatchTarget, items: readonly SpotifyTrack[]): SpotifyTrack | null {
  const title = normTitle(t.title);
  const live = isLive(t.title);
  let best: SpotifyTrack | null = null;
  let bestScore = 0;
  for (const it of items) {
    // The catalog keeps studio versions; don't trade one for a concert recording.
    if (!live && isLive(it.name)) continue;
    if (
      !artistMatches(
        t.artist,
        it.artists.map((a) => a.name),
      )
    )
      continue;
    const name = normTitle(it.name);
    if (!close(title, name)) continue;
    const s = similarity(title, name);
    if (s > bestScore) {
      best = it;
      bestScore = s;
    }
  }
  return best;
}

const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
/** Quotes would end a field filter early. */
const clean = (s: string) => s.replace(/["]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);

const matched = (t: SpotifyTrack, via: Matched["via"]): Matched => ({
  uri: t.uri,
  name: t.name,
  artists: t.artists.map((a) => a.name),
  via,
});

/**
 * One song: each ISRC (up to 3) until Spotify knows one, then `track:"…" artist:"…"`, then the
 * same words without field filters if that found nothing at all. 1–5 calls.
 */
export async function matchTrack(client: SpotifyClient, t: MatchTarget): Promise<Matched | null> {
  const isrcs = t.isrcs.map((s) => s.toUpperCase()).filter((s) => ISRC.test(s));
  for (const isrc of isrcs.slice(0, MAX_ISRC_TRIES)) {
    const [hit] = await client.searchTracks(`isrc:${isrc}`, 1);
    if (hit) return matched(hit, "isrc");
  }
  const title = clean(stripVersion(t.title)) || clean(t.title);
  const artist = clean(t.artist.split(CREDIT_SPLIT)[0] ?? t.artist);
  let items = await client.searchTracks(`track:"${title}" artist:"${artist}"`, SEARCH_LIMIT_MAX);
  if (items.length === 0) items = await client.searchTracks(`${title} ${artist}`, SEARCH_LIMIT_MAX);
  const best = pickBest(t, items);
  return best ? matched(best, "search") : null;
}

/**
 * Recent matches, misses included, so pushing an edited playlist again doesn't search again. In
 * memory only and short-lived: Spotify's Developer Terms allow only temporary caching of metadata.
 */
export class MatchCache {
  private readonly entries = new Map<string, { at: number; value: Matched | null }>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;
  constructor(ttlMs = 60 * 60 * 1000, max = 5000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
  }

  static key(account: string, t: MatchTarget): string {
    return [account, t.isrcs.join(","), t.title, t.artist].join("\n");
  }

  get(key: string): Matched | null | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: Matched | null): void {
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), value });
    // Map order is insertion order: drop the oldest.
    while (this.entries.size > this.max) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.entries.delete(first);
    }
  }
}
