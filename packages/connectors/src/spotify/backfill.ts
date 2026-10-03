import { backfillStep, type CatalogColumns, generate, type PlaylistStep } from "@abtune/engine";
import type { Backfill, PushSong } from "./push.ts";

/** What backfill needs from a loaded catalog (`@abtune/catalog/reader`'s LoadedCatalog fits). */
export interface BackfillCatalog {
  readonly columns: CatalogColumns;
  indexOf(trackId: string): number;
  meta(indices: readonly number[]): Promise<
    readonly {
      readonly track_id: string;
      readonly title: string;
      readonly artist_credit: string;
      readonly isrcs: readonly string[];
    }[]
  >;
}

/**
 * Replacements from the generator (HANDOFF §11.1): for each song Spotify doesn't have, the next
 * pick from the same (primary cluster, decade) cell by an artist not on the list, from the first
 * playlist's taste; any cell when that one has nothing left. Seeds come from the playlist's seed,
 * so the same push gives the same replacements.
 */
export function catalogBackfill(catalog: BackfillCatalog, first: PlaylistStep): Backfill {
  let n = 0;
  return async (slots, exclude) => {
    const previous = [...exclude].map((id) => catalog.indexOf(id)).filter((i) => i >= 0);
    const picks: number[] = [];
    for (const slot of slots) {
      const step = backfillStep(first, ++n);
      const run = (sameCellAs?: number) =>
        generate(catalog.columns, step.taste, {
          length: 1,
          seed: step.seed,
          previous,
          newArtistsOnly: true,
          ...(sameCellAs === undefined ? {} : { sameCellAs }),
        }).tracks[0]?.index;
      const at = catalog.indexOf(slot.missing.track_id);
      const pick = (at >= 0 ? run(at) : undefined) ?? run();
      picks.push(pick ?? -1);
      if (pick !== undefined) previous.push(pick);
    }
    const meta = await catalog.meta(picks.filter((i) => i >= 0));
    let k = 0;
    return picks.map((i): PushSong | null => {
      if (i < 0) return null;
      const m = meta[k++];
      return m
        ? { track_id: m.track_id, title: m.title, artist: m.artist_credit, isrcs: m.isrcs }
        : null;
    });
  };
}
