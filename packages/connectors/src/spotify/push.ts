// Push a playlist (HANDOFF §11.1): match every song, backfill the ones Spotify doesn't have so the
// playlist keeps N songs, then create it (private by default) and add the tracks in batches.
import { ADD_BATCH, type CreatedPlaylist, type SpotifyClient } from "./client.ts";
import { SpotifyError } from "./errors.ts";
import { MatchCache, type Matched, type MatchTarget, matchTrack } from "./match.ts";

export interface PushSong extends MatchTarget {
  /** Catalog id (MusicBrainz recording MBID). */
  readonly track_id: string;
}

export interface BackfillSlot {
  readonly position: number;
  /** The song Spotify didn't have (its cell is where the replacement comes from). */
  readonly missing: PushSong;
}

/**
 * One replacement per slot, or null when there is none. Never a song in `exclude` (everything
 * on the list or already tried). `round` counts from 1.
 */
export type Backfill = (
  slots: readonly BackfillSlot[],
  exclude: ReadonlySet<string>,
  round: number,
) => Promise<(PushSong | null)[]>;

export interface PushOptions {
  readonly name: string;
  readonly description: string;
  /** Default false: private. */
  readonly public?: boolean;
  readonly songs: readonly PushSong[];
  readonly backfill?: Backfill;
  readonly cache?: MatchCache;
  /** Scopes cache entries (a Spotify user id): matches depend on the user's market. */
  readonly account?: string;
  /** Searches in flight (default 3). */
  readonly concurrency?: number;
}

export interface PushReport {
  readonly playlist: CreatedPlaylist;
  readonly requested: number;
  readonly added: number;
  /** Found on the first pass, before any backfill. */
  readonly matched: number;
  readonly byIsrc: number;
  /** Songs with an ISRC, and how many of them the first pass found (§16 #7: ≥ 90%). */
  readonly withIsrc: number;
  readonly withIsrcMatched: number;
  readonly replaced: readonly {
    readonly position: number;
    readonly missing: PushSong;
    readonly replacement: PushSong;
  }[];
  /** Songs nothing could replace: the playlist is this many songs short. */
  readonly missing: readonly PushSong[];
  /** Spotify requests made (§11.1 budget: ~50–80 for 50 songs). */
  readonly calls: number;
}

export const BACKFILL_ROUNDS = 3;
/** Spotify's limits on a playlist's name and description. */
export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 300;

/** One line, no angle brackets (Spotify rejects them in descriptions), within `max`. */
export function cleanText(s: string, max: number): string {
  const one = s
    .replace(/[\r\n\t<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/** The description, ending "Made with ABTune" (HANDOFF §11.1), within Spotify's limit. */
export function playlistDescription(description: string): string {
  const tail = "Made with ABTune";
  const head = cleanText(description, DESCRIPTION_MAX - tail.length - 3);
  return head ? `${head} · ${tail}` : tail;
}

export async function pushPlaylist(client: SpotifyClient, opts: PushOptions): Promise<PushReport> {
  const { songs } = opts;
  const limit = opts.concurrency ?? 3;
  const cache = opts.cache;
  const account = opts.account ?? "";
  const find = async (s: PushSong): Promise<Matched | null> => {
    const key = MatchCache.key(account, s);
    const hit = cache?.get(key);
    if (hit !== undefined) return hit;
    const m = await matchTrack(client, s);
    cache?.set(key, m);
    return m;
  };

  const uris: (string | null)[] = songs.map(() => null);
  const used = new Set<string>();
  const take = (i: number, m: Matched | null) => {
    // Two catalog recordings can be the same Spotify track: the second one counts as missing.
    if (!m || used.has(m.uri)) return false;
    uris[i] = m.uri;
    used.add(m.uri);
    return true;
  };

  const first = await mapLimit(songs, limit, find);
  let matched = 0;
  let byIsrc = 0;
  let withIsrc = 0;
  let withIsrcMatched = 0;
  first.forEach((m, i) => {
    const ok = take(i, m);
    const hasIsrc = (songs[i]?.isrcs.length ?? 0) > 0;
    if (hasIsrc) withIsrc++;
    if (!ok) return;
    matched++;
    if (m?.via === "isrc") byIsrc++;
    if (hasIsrc) withIsrcMatched++;
  });

  const exclude = new Set(songs.map((s) => s.track_id));
  const replaced: PushReport["replaced"][number][] = [];
  let open = uris.flatMap((u, i) => (u === null ? [i] : []));
  for (let round = 1; round <= BACKFILL_ROUNDS && open.length > 0 && opts.backfill; round++) {
    const slots = open.map((p) => ({ position: p, missing: songs[p] as PushSong }));
    const subs = await opts.backfill(slots, exclude, round);
    for (const s of subs) if (s) exclude.add(s.track_id);
    const found = await mapLimit(subs, limit, (s) => (s ? find(s) : Promise.resolve(null)));
    const still: number[] = [];
    open.forEach((p, k) => {
      const sub = subs[k];
      if (!sub) return; // nothing left in that cell: give the slot up
      if (take(p, found[k] ?? null))
        replaced.push({ position: p, missing: songs[p] as PushSong, replacement: sub });
      else still.push(p);
    });
    open = still;
  }

  const final = uris.filter((u): u is string => u !== null);
  if (final.length === 0)
    throw new SpotifyError("no_matches", "None of these songs could be found on Spotify.");

  const playlist = await client.createPlaylist({
    name: cleanText(opts.name, NAME_MAX) || "ABTune",
    description: cleanText(opts.description, DESCRIPTION_MAX),
    public: opts.public ?? false,
  });
  try {
    for (let i = 0; i < final.length; i += ADD_BATCH)
      await client.addItems(playlist.id, final.slice(i, i + ADD_BATCH));
  } catch (err) {
    if (err instanceof SpotifyError)
      throw new SpotifyError(err.kind, err.message, {
        status: err.status,
        retryAfter: err.retryAfter,
        partial: playlist,
      });
    throw err;
  }

  return {
    playlist,
    requested: songs.length,
    added: final.length,
    matched,
    byIsrc,
    withIsrc,
    withIsrcMatched,
    replaced: replaced.sort((a, b) => a.position - b.position),
    missing: uris.flatMap((u, i) => (u === null ? [songs[i] as PushSong] : [])),
    calls: client.calls,
  };
}

/** `fn` over `items` with at most `limit` in flight, results in order; the first error wins. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (x: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let error: { e: unknown } | null = null;
  const worker = async () => {
    while (error === null && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i] as T);
      } catch (e) {
        error ??= { e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (error) throw (error as { e: unknown }).e;
  return out;
}
