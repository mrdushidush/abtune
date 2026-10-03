// data/il_artists.yaml: the owner-curated Israeli artists whose best-known songs join the hits view.
// The popularity data barely sees Israeli listeners, so this list, not listener counts, decides
// which Israeli artists count as known (owner decision, 2026-10-03).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { type Db, pathLit } from "./db.ts";

export const DEFAULT_IL_ARTISTS = "data/il_artists.yaml";

/** Up to this many pinned signature songs per artist. */
export const MAX_PINS = 3;

const artistSchema = z.strictObject({
  /** The artist as credited in the catalog (for people reading the file). */
  name: z.string().min(1),
  /** MusicBrainz artist id: what the build matches. */
  mbid: z.uuid(),
  /** 1 = household name, 2 = well known, 3 = known. */
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  /** Signature songs, best first, as catalog titles (matched like the catalog's dedupe). */
  songs: z.array(z.string().min(1)).max(MAX_PINS).default([]),
});

const fileSchema = z.strictObject({
  version: z.literal(1),
  artists: z.array(artistSchema).default([]),
});

export type IlArtist = z.infer<typeof artistSchema>;

export interface IlArtists {
  readonly artists: readonly IlArtist[];
  /** The YAML text ("" when there is no file), hashed into the build's stage inputs. */
  readonly text: string;
}

/** Read and validate the list. A missing file means "no curation yet" (empty list). */
export async function loadIlArtists(file: string | undefined): Promise<IlArtists> {
  if (!file) return { artists: [], text: "" };
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { artists: [], text: "" };
    throw err;
  }
  const parsed = fileSchema.safeParse(parse(text));
  if (!parsed.success) {
    throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  }
  const seen = new Set<string>();
  for (const a of parsed.data.artists) {
    if (seen.has(a.mbid)) throw new Error(`${file}: artist ${a.mbid} (${a.name}) is listed twice`);
    seen.add(a.mbid);
  }
  return { artists: parsed.data.artists, text };
}

/** One artist in a draft list, with what our own data says about them. */
export interface DraftArtist {
  readonly name: string;
  readonly mbid: string;
  readonly tier: 1 | 2 | 3;
  /** Israeli-market songs in the catalog. */
  readonly songs: number;
  /** The artist's top 3 by our data: title, year, listeners. */
  readonly top: readonly { title: string; year: number | null; listeners: number }[];
}

/**
 * Candidates for the curated list from a built catalog: artists with Israeli-market songs or an
 * Israeli country, ranked by our own fame score (songs, compilations, listeners), with their
 * top 3 songs. The first `tier1` get tier 1, the next `tier2` tier 2, the rest tier 3.
 */
export async function draftIlArtists(
  db: Db,
  catalogDir: string,
  { limit = 900, tier1 = 150, tier2 = 300 } = {},
): Promise<DraftArtist[]> {
  const src = `read_parquet(${pathLit(path.join(catalogDir, "tracks.parquet"))})`;
  const artists = await db.all<{ mbid: string; name: string; songs: number }>(`
    WITH t AS (
      SELECT artist_mbids[1] AS mbid, artist_credit, comps, listeners,
             market = 'il' OR artist_country = 'IL' AS il
      FROM ${src}
    ), a AS (
      SELECT mbid, count(*) FILTER (WHERE il) AS songs,
             ln(1 + count(*) FILTER (WHERE il)) + ln(1 + coalesce(sum(comps) FILTER (WHERE il), 0))
               + 0.5 * ln(1 + coalesce(max(listeners) FILTER (WHERE il), 0)) AS fame
      FROM t GROUP BY mbid HAVING count(*) FILTER (WHERE il) > 0
    ), n AS (
      SELECT mbid, artist_credit AS name,
             row_number() OVER (PARTITION BY mbid ORDER BY count(*) DESC, artist_credit) AS r
      FROM t WHERE mbid IN (SELECT mbid FROM a) GROUP BY mbid, artist_credit
    )
    SELECT a.mbid, n.name, a.songs FROM a JOIN n ON n.mbid = a.mbid AND n.r = 1
    ORDER BY a.fame DESC, a.mbid LIMIT ${limit}`);
  const top = await db.all<{
    mbid: string;
    title: string;
    year: number | null;
    listeners: number;
  }>(`
    SELECT artist_mbids[1] AS mbid, title, year, listeners FROM ${src}
    WHERE artist_rank <= 3 AND artist_mbids[1] IN (${artists.map((a) => `'${a.mbid}'`).join(", ") || "NULL"})
    ORDER BY artist_mbids[1], artist_rank`);
  const byArtist = new Map<string, DraftArtist["top"][number][]>();
  for (const t of top) {
    const list = byArtist.get(t.mbid) ?? [];
    list.push({ title: t.title, year: t.year, listeners: Number(t.listeners) });
    byArtist.set(t.mbid, list);
  }
  return artists.map((a, i) => ({
    name: a.name,
    mbid: a.mbid,
    tier: i < tier1 ? 1 : i < tier1 + tier2 ? 2 : 3,
    songs: Number(a.songs),
    top: byArtist.get(a.mbid) ?? [],
  }));
}

const yamlString = (s: string) => JSON.stringify(s);

/**
 * The draft as YAML for the owner to edit: tier-1 artists get their top 3 as pinned `songs` to
 * correct; everyone's top 3 by our data is in a comment.
 */
export function renderIlArtists(draft: readonly DraftArtist[], catalogVersion: string): string {
  const out = [
    "# Israeli artists whose best-known songs join the hits view (owner decision D4, 2026-10-03).",
    `# Drafted by \`abtune catalog il-draft\` from ${catalogVersion}: ranked by our own data (Israeli songs,`,
    "# compilations, listeners), which barely sees Israeli listeners. Please edit:",
    "#   - delete artists who aren't Israeli or aren't known; add missing ones (name + mbid; ask Claude",
    "#     to look up the MusicBrainz id if you only have the name);",
    "#   - tier: 1 = household name, 2 = well known, 3 = known. Order inside a tier doesn't matter;",
    "#   - songs: up to 3 signature songs, best first, as catalog titles. Tier-1 artists start with",
    "#     our data's top 3: fix the wrong ones. Empty = ranked by our data (shown in the comment).",
    "# Every listed artist's top 3 songs become hits; artists not listed are never Israeli hits.",
    "version: 1",
    "artists:",
  ];
  for (const a of draft) {
    const ours = a.top
      .map((t) => `${t.title} (${t.year ?? "?"}, ${t.listeners.toLocaleString("en")})`)
      .join(" · ");
    out.push(`  # ${a.songs} songs; our top 3: ${ours || "none"}`);
    out.push(`  - name: ${yamlString(a.name)}`);
    out.push(`    mbid: ${a.mbid}`);
    out.push(`    tier: ${a.tier}`);
    const pins = a.tier === 1 ? a.top.map((t) => yamlString(t.title)) : [];
    out.push(`    songs: [${pins.join(", ")}]`);
  }
  return `${out.join("\n")}\n`;
}
