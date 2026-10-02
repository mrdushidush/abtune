// Stages 4 and 9: final popularity, then the top-N selection with coverage quotas (§6.2 stage 3).
import { type Db, pathLit } from "../db.ts";
import { type Pool, poolPredicate } from "./genres.ts";

/**
 * MBIDs to ask the popularity API about: every ListenBrainz-seen MBID of each kept candidate, and
 * for seeded candidates nobody has in a top list, every canonical recording of the song.
 */
export async function apiQueryMbids(db: Db): Promise<string[]> {
  await db.run(`
    CREATE OR REPLACE TABLE api_query AS
      SELECT DISTINCT cu.unit AS song, lc.lb_gid AS gid
      FROM lb_canon lc JOIN canon_unit cu ON cu.canon = lc.canon
      WHERE cu.unit IN (SELECT song FROM cand_drop WHERE reason IS NULL)
      UNION
      SELECT c.song, c.gid FROM cand c JOIN cand_drop d USING (song) WHERE d.reason IS NULL
      UNION
      SELECT cu.unit, ci.gid
      FROM canon_unit cu JOIN canon_info ci ON ci.id = cu.canon
      WHERE cu.unit IN (SELECT c.song FROM cand c JOIN cand_drop d USING (song)
                        WHERE d.reason IS NULL AND c.proxy_listeners = 0);
  `);
  const rows = await db.all<{ gid: string }>(
    `SELECT DISTINCT gid::VARCHAR AS gid FROM api_query ORDER BY gid`,
  );
  return rows.map((r) => r.gid);
}

/**
 * song_pop: listeners = max over the song's MBIDs (unique listeners can't be summed), listens = sum.
 * Without API data (or with --no-api) the dump-derived proxy is used.
 */
export async function buildSongPopularity(db: Db, cacheFile: string | undefined): Promise<void> {
  if (cacheFile) {
    await db.run(String.raw`
      CREATE OR REPLACE TABLE api_pop AS
        SELECT DISTINCT ON (gid) gid, users, listens
        FROM read_csv(${pathLit(cacheFile)}, delim='\t', header=false, quote='', escape='', auto_detect=false,
          columns={'gid': 'UUID', 'users': 'BIGINT', 'listens': 'BIGINT'}, ignore_errors=true)
        ORDER BY gid, users DESC NULLS LAST;
    `);
  } else {
    await db.run(`CREATE OR REPLACE TABLE api_pop (gid UUID, users BIGINT, listens BIGINT)`);
  }
  await db.run(`
    CREATE OR REPLACE TABLE song_pop AS
      WITH api AS (
        SELECT q.song, max(p.users) AS users, sum(p.listens) AS listens
        FROM api_query q JOIN api_pop p ON p.gid = q.gid
        GROUP BY q.song
      )
      SELECT c.song,
             coalesce(api.users, c.proxy_listeners) AS listeners,
             coalesce(api.listens, c.proxy_listens) AS listens,
             api.users IS NOT NULL AS from_api
      FROM cand c JOIN cand_drop d USING (song) LEFT JOIN api USING (song)
      WHERE d.reason IS NULL;
  `);
}

export interface SelectionStats {
  readonly selected: number;
  readonly pools: {
    readonly name: string;
    readonly min: number;
    readonly inTop: number;
    readonly added: number;
    readonly final: number;
  }[];
}

/**
 * sel: the top `target` songs by (listeners, listens, gid); each pool is topped up to its minimum
 * with its next-best songs that have at least one known listener, trimming the lowest-ranked
 * non-pool songs to keep the total.
 */
export async function buildSelection(
  db: Db,
  target: number,
  pools: readonly Pool[],
): Promise<SelectionStats> {
  const anyPool = pools.map((p) => poolPredicate(p, "c")).join(" OR ") || "false";
  await db.run(`
    CREATE OR REPLACE TABLE ranked AS
      SELECT c.song, p.listeners, p.listens, (${anyPool}) AS in_pool,
             row_number() OVER (ORDER BY p.listeners DESC, p.listens DESC, c.gid) AS rk
      FROM cand c JOIN song_pop p USING (song);
    CREATE OR REPLACE TABLE sel_ids AS SELECT song, 'rank' AS via FROM ranked WHERE rk <= ${target};
  `);
  const stats: SelectionStats["pools"][number][] = [];
  for (const pool of pools) {
    const inTop = await db.value<number>(
      `SELECT count(*) FROM sel_ids s JOIN cand c USING (song) WHERE ${poolPredicate(pool, "c")}`,
    );
    const need = Math.max(0, pool.min - inTop);
    let added = 0;
    if (need > 0) {
      await db.run(`
        CREATE OR REPLACE TABLE pool_add AS
          SELECT r.song FROM ranked r JOIN cand c USING (song)
          WHERE ${poolPredicate(pool, "c")} AND r.listeners > 0 AND r.song NOT IN (SELECT song FROM sel_ids)
          ORDER BY r.rk LIMIT ${need};
      `);
      added = await db.value<number>(`SELECT count(*) FROM pool_add`);
      // Trim as many of the lowest-ranked songs that belong to no pool.
      await db.run(`
        DELETE FROM sel_ids WHERE song IN (
          SELECT s.song FROM sel_ids s JOIN ranked r USING (song)
          WHERE NOT r.in_pool ORDER BY r.rk DESC LIMIT ${added});
        INSERT INTO sel_ids SELECT song, 'quota:${pool.name}' FROM pool_add;
      `);
    }
    const final = await db.value<number>(
      `SELECT count(*) FROM sel_ids s JOIN cand c USING (song) WHERE ${poolPredicate(pool, "c")}`,
    );
    stats.push({ name: pool.name, min: pool.min, inTop, added, final });
  }
  await db.run(`
    CREATE OR REPLACE TABLE sel AS
      SELECT c.*, r.listeners, r.listens, r.rk AS popularity_rank, s.via
      FROM sel_ids s JOIN cand c USING (song) JOIN ranked r USING (song);
  `);
  return { selected: await db.value<number>(`SELECT count(*) FROM sel`), pools: stats };
}
