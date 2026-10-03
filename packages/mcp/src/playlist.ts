// Playlists in process: the same generator steps the web app requests over HTTP (engine `edits.ts`),
// so a share code gives the same songs here as in the browser.
import { findCatalog } from "@abtune/catalog";
import { type LoadedCatalog, loadCatalog } from "@abtune/catalog/reader";
import {
  applyEdit,
  type Dimensions,
  editStep,
  firstStep,
  type GenerateWarning,
  generate,
  naturalShares,
  type PlaylistStep,
  type PlaylistTrack,
  playlistBase,
  playShortlist,
  type ShareData,
  type ShareOp,
  shortlistLength,
  warmFamiliarity,
} from "@abtune/engine";

export interface TrackRow {
  readonly track_id: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string | null;
  readonly year: number | null;
  readonly isrcs: readonly string[];
  readonly length_ms: number | null;
  readonly genre: string | null;
}

export interface BuiltPlaylist {
  readonly tracks: readonly TrackRow[];
  readonly warnings: readonly GenerateWarning[];
  /** Edits that came back empty (the list stops short of the original). */
  readonly skipped: number;
}

/** Load the installed catalog once, on first use (the full one takes ~8 s and ~350 MB). */
export class CatalogHandle {
  private loading: Promise<LoadedCatalog> | null = null;
  private readonly root: string;
  private readonly explicit: string | undefined;
  private readonly dims: Dimensions;
  constructor(root: string, explicit: string | undefined, dims: Dimensions) {
    this.root = root;
    this.explicit = explicit;
    this.dims = dims;
  }

  get(): Promise<LoadedCatalog> {
    this.loading ??= (async () => {
      const installed = await findCatalog(this.root, this.explicit);
      if (!installed)
        throw new Error(
          "No music catalog is installed. Run `pnpm abtune catalog fetch` (dev sample) first.",
        );
      const loaded = await loadCatalog(installed.dir, this.dims);
      warmFamiliarity(loaded.columns);
      naturalShares(loaded.columns);
      return loaded;
    })();
    // A failed load can be retried by the next call.
    this.loading.catch(() => {
      this.loading = null;
    });
    return this.loading;
  }

  close(): void {
    this.loading?.then((c) => c.close()).catch(() => {});
  }
}

function run(catalog: LoadedCatalog, step: PlaylistStep, previous: readonly number[]) {
  return generate(catalog.columns, step.taste, {
    length: step.length,
    seed: step.seed,
    previous: [...previous],
    newArtistsOnly: step.swap,
  });
}

/**
 * The first page: the generator's, or a web AI rerank's picks replayed from its shortlist (no AI
 * here: the MCP host is the model).
 */
function firstPage(
  catalog: LoadedCatalog,
  first: PlaylistStep,
  picks: readonly number[] | undefined,
): { indices: number[]; warnings: readonly GenerateWarning[] } {
  if (!picks) {
    const out = run(catalog, first, []);
    return { indices: out.tracks.map((t) => t.index), warnings: out.warnings };
  }
  const short = generate(catalog.columns, first.taste, {
    length: shortlistLength(first.length),
    seed: first.seed,
  });
  const play = playShortlist(catalog.columns, short.tracks, picks, first.length);
  return {
    indices: play.map((p) => (short.tracks[p] as PlaylistTrack).index),
    warnings:
      play.length < first.length && !short.warnings.includes("catalog_exhausted")
        ? [...short.warnings, "catalog_exhausted"]
        : short.warnings,
  };
}

/** The first playlist, then each edit on the list as it stood: exactly the web app's requests. */
export async function buildPlaylist(
  catalog: LoadedCatalog,
  dims: Dimensions,
  data: Pick<ShareData, "taste" | "tweaks" | "seed" | "length" | "ops" | "adjust" | "picks">,
): Promise<BuiltPlaylist> {
  const base = playlistBase(dims, data.taste, data.adjust);
  const first = firstStep(dims, base, data.tweaks, data.seed, data.length);
  const out = firstPage(catalog, first, data.picks);
  let indices = out.indices;
  const done: ShareOp[] = [];
  let skipped = 0;
  for (const op of data.ops) {
    if (op.op === "swap" && op.index >= indices.length) {
      skipped++;
      continue;
    }
    const step = editStep(dims, base, data.tweaks, first, done, op);
    const got = run(catalog, step, indices).tracks.map((t) => t.index);
    if (got.length === 0) {
      skipped++;
      continue;
    }
    indices = applyEdit(indices, op, got);
    done.push(op);
  }
  const meta = await catalog.meta(indices);
  return {
    tracks: meta.map((m) => ({
      track_id: m.track_id,
      title: m.title,
      artist: m.artist_credit,
      album: m.release_title,
      year: m.year,
      isrcs: m.isrcs,
      length_ms: m.length_ms,
      genre: m.primary_cluster,
    })),
    warnings: out.warnings,
    skipped,
  };
}
