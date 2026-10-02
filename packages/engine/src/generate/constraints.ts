import type { CatalogColumns } from "./columns.ts";
import { artistCap, DEFAULT_GENERATOR_PARAMS, type GeneratorParams } from "./params.ts";

export type ViolationRule =
  | "length"
  | "duplicate_track"
  | "artist_cap"
  | "duplicate_title"
  | "adjacent_artist";

export interface Violation {
  readonly rule: ViolationRule;
  /** Position in the playlist, when the rule is about one. */
  readonly at?: number;
}

/**
 * HANDOFF §9.3, checked independently of the generator: exactly `length` tracks, at most
 * 2 per artist (1 if length ≤ 25), no duplicate normalized titles, no adjacent same artist.
 */
export function checkPlaylist(
  columns: CatalogColumns,
  tracks: readonly number[],
  length: number,
  params: GeneratorParams = DEFAULT_GENERATOR_PARAMS,
): Violation[] {
  const out: Violation[] = [];
  if (tracks.length !== length) out.push({ rule: "length" });
  const cap = artistCap(length, params);
  const seen = new Set<number>();
  const perArtist = new Map<number, number>();
  const titles = new Set<number>();
  tracks.forEach((t, at) => {
    if (seen.has(t)) out.push({ rule: "duplicate_track", at });
    seen.add(t);
    const a = columns.artist[t] as number;
    const count = (perArtist.get(a) ?? 0) + 1;
    perArtist.set(a, count);
    if (count > cap) out.push({ rule: "artist_cap", at });
    const title = columns.titleKey[t] as number;
    if (titles.has(title)) out.push({ rule: "duplicate_title", at });
    titles.add(title);
    if (at > 0 && columns.artist[tracks[at - 1] as number] === a) {
      out.push({ rule: "adjacent_artist", at });
    }
  });
  return out;
}
