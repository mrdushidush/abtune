// Tier-3 feature imputation (HANDOFF §6.4): per-dim ridge regression, fit in TypeScript on rows
// streamed from DuckDB in a fixed order, applied back in SQL. Reports held-out MAE.
import type { Db } from "./db.ts";

/** Solve (A + λ·diag(penalize)) β = b by Cholesky. A is p×p row-major, symmetric positive definite. */
export function solveRidge(
  A: Float64Array,
  b: Float64Array,
  p: number,
  lambda: number,
  penalize: readonly boolean[],
): Float64Array {
  const M = Float64Array.from(A);
  for (let i = 0; i < p; i++) if (penalize[i]) M[i * p + i] = (M[i * p + i] ?? 0) + lambda;
  // Cholesky: M = L Lᵀ (in place, lower triangle).
  for (let j = 0; j < p; j++) {
    let d = M[j * p + j] ?? 0;
    for (let k = 0; k < j; k++) d -= (M[j * p + k] ?? 0) ** 2;
    if (!(d > 1e-12)) d = 1e-12; // a never-seen feature column: tiny pivot keeps β at 0
    const ljj = Math.sqrt(d);
    M[j * p + j] = ljj;
    for (let i = j + 1; i < p; i++) {
      let s = M[i * p + j] ?? 0;
      for (let k = 0; k < j; k++) s -= (M[i * p + k] ?? 0) * (M[j * p + k] ?? 0);
      M[i * p + j] = s / ljj;
    }
  }
  const y = new Float64Array(p);
  for (let i = 0; i < p; i++) {
    let s = b[i] ?? 0;
    for (let k = 0; k < i; k++) s -= (M[i * p + k] ?? 0) * (y[k] ?? 0);
    y[i] = s / (M[i * p + i] ?? 1);
  }
  const beta = new Float64Array(p);
  for (let i = p - 1; i >= 0; i--) {
    let s = y[i] ?? 0;
    for (let k = i + 1; k < p; k++) s -= (M[k * p + i] ?? 0) * (beta[k] ?? 0);
    beta[i] = s / (M[i * p + i] ?? 1);
  }
  return beta;
}

/** Normal-equation accumulator: XᵀX and Xᵀy over rows, in arrival order (deterministic). */
export class Normal {
  readonly p: number;
  readonly A: Float64Array;
  readonly b: Float64Array;
  n = 0;
  sumY = 0;
  constructor(p: number) {
    this.p = p;
    this.A = new Float64Array(p * p);
    this.b = new Float64Array(p);
  }
  add(x: ArrayLike<number>, y: number): void {
    const { p, A, b } = this;
    for (let i = 0; i < p; i++) {
      const xi = x[i] ?? 0;
      if (xi === 0) continue;
      b[i] = (b[i] ?? 0) + xi * y;
      const row = i * p;
      for (let j = 0; j <= i; j++) A[row + j] = (A[row + j] ?? 0) + xi * (x[j] ?? 0);
    }
    this.n++;
    this.sumY += y;
  }
  /** Mirror the lower triangle into a full symmetric matrix. */
  full(): Float64Array {
    const { p, A } = this;
    const M = Float64Array.from(A);
    for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) M[i * p + j] = M[j * p + i] ?? 0;
    return M;
  }
}

export const LAMBDAS = [0.1, 1, 10, 100] as const;
/** Shrinkage of artist / release-group means toward the global mean (pseudo-count). */
const SHRINK = 2;

export interface DimReport {
  readonly lambda: number;
  readonly maeRandom: number;
  readonly baselineRandom: number;
  readonly maeArtist: number;
  readonly baselineArtist: number;
  readonly maeByDecade: Record<string, number>;
}

export interface ImputeReport {
  readonly trainRows: number;
  readonly validationRows: number;
  readonly testRows: number;
  readonly artistTestRows: number;
  readonly predicted: number;
  readonly features: readonly string[];
  readonly dims: Record<string, DimReport>;
}

const SPLIT = { train: 0, val: 1, test: 2, artistTest: 3, target: 4 } as const;

/**
 * Build `imp_x` (one row per candidate: targets, shared features, per-dim artist/RG means) and
 * fit one ridge model per dim. Writes predictions for `sel` songs lacking tiers 1–2 to `dims_model`.
 */
export async function impute(
  db: Db,
  dims: readonly string[],
  clusters: readonly string[],
  decades: readonly string[],
  log: (line: string) => void,
): Promise<ImputeReport> {
  const langs = ["lang_en", "lang_he", "lang_fr", "lang_es", "lang_other", "none", "unknown"];
  const ident = (s: string) => s.replace(/[^a-z0-9_]/g, "_");
  const shared = [
    ...clusters.map((c) => `w_${ident(c)}`),
    ...decades.map((d) => `d_${ident(d)}`),
    "d_unknown",
    ...langs.map((l) => `l_${ident(l)}`),
    "loglisten",
  ];
  const yCols = dims.map((d) => `y_${d}`);
  const meanCols = dims.flatMap((d) => [`art_${d}`, `rg_${d}`]);

  // Split by stable hashes: 5% random test, 5% validation, and 5% of *artists* held out entirely
  // (their artist/album means are masked), the proxy for new and post-2022 artists.
  await db.run(`
    CREATE OR REPLACE TABLE imp_base AS
      SELECT c.song, c.gid, c.first_artist, c.release_group, c.decade, c.language,
             ln(1 + c.proxy_listeners) AS ll,
             ${dims.map((d) => `t.${d} AS y_${d}`).join(", ")},
             t.song IS NOT NULL AS has_y,
             md5_number(c.first_artist_gid::VARCHAR) % 20 = 0 AS art_holdout,
             md5_number(c.gid::VARCHAR) % 20 AS bucket,
             c.song IN (SELECT song FROM sel) AND c.song NOT IN (SELECT song FROM dims_t1)
               AND c.song NOT IN (SELECT song FROM dims_t2) AS target
      FROM cand c LEFT JOIN dims_t1 t USING (song)
      WHERE c.song IN (SELECT song FROM sel) OR t.song IS NOT NULL;
  `);
  const mu = await db.one<Record<string, number>>(
    `SELECT ${dims.map((d) => `avg(y_${d}) AS ${d}`).join(", ")}, avg(ll) AS ll_mean, stddev_pop(ll) AS ll_sd
     FROM imp_base WHERE has_y AND NOT art_holdout AND bucket > 1`,
  );
  const stat = (key: string, by: string) => `
    CREATE OR REPLACE TABLE imp_${key} AS
      SELECT ${by}, count(*) AS n, ${dims.map((d) => `sum(y_${d}::DECIMAL(18, 9))::DOUBLE AS s_${d}`).join(", ")}
      FROM imp_base WHERE has_y AND ${by} IS NOT NULL GROUP BY ${by};`;
  await db.run(stat("art", "first_artist") + stat("rg", "release_group"));
  await db.run(`
    CREATE OR REPLACE TABLE imp_cluster AS
      PIVOT (SELECT song, cluster, w FROM cand_cluster WHERE song IN (SELECT song FROM imp_base))
      ON cluster IN (${clusters.map((c) => `'${c}'`).join(", ")}) USING first(w) GROUP BY song;
  `);
  const loo = (key: string, d: string) => {
    const self = `(CASE WHEN b.has_y THEN 1 ELSE 0 END)`;
    const selfY = `(CASE WHEN b.has_y THEN b.y_${d} ELSE 0 END)`;
    return `CASE WHEN b.art_holdout OR coalesce(${key}.n, 0) - ${self} <= 0 THEN ${mu[d]}
                 ELSE (${key}.s_${d} - ${selfY} + ${SHRINK} * ${mu[d]}) / (${key}.n - ${self} + ${SHRINK}) END`;
  };
  const has = (key: string) =>
    `CASE WHEN b.art_holdout OR coalesce(${key}.n, 0) - (CASE WHEN b.has_y THEN 1 ELSE 0 END) <= 0 THEN 0 ELSE 1 END`;
  await db.run(`
    CREATE OR REPLACE TABLE imp_x AS
      SELECT b.song, b.gid, b.decade,
        CASE WHEN b.target THEN ${SPLIT.target} WHEN NOT b.has_y THEN -1
             WHEN b.art_holdout THEN ${SPLIT.artistTest} WHEN b.bucket = 0 THEN ${SPLIT.test}
             WHEN b.bucket = 1 THEN ${SPLIT.val} ELSE ${SPLIT.train} END AS split,
        ${yCols.join(", ")},
        ${clusters.map((c) => `coalesce(k."${c}", 0)::DOUBLE AS w_${ident(c)}`).join(", ")},
        ${decades.map((d) => `(b.decade = '${d}')::INTEGER::DOUBLE AS d_${ident(d)}`).join(", ")},
        (b.decade IS NULL)::INTEGER::DOUBLE AS d_unknown,
        ${langs.map((l) => `(b.language = '${l}')::INTEGER::DOUBLE AS l_${ident(l)}`).join(", ")},
        (b.ll - ${mu.ll_mean}) / ${mu.ll_sd || 1} AS loglisten,
        ${dims.map((d) => `(${loo("a", d)})::DOUBLE AS art_${d}, (${loo("r", d)})::DOUBLE AS rg_${d}`).join(",\n        ")},
        (${has("a")})::DOUBLE AS has_art, (${has("r")})::DOUBLE AS has_rg
      FROM imp_base b
      LEFT JOIN imp_art a ON a.first_artist = b.first_artist
      LEFT JOIN imp_rg r ON r.release_group = b.release_group
      LEFT JOIN imp_cluster k ON k.song = b.song;
  `);

  // Design per dim: [1, shared…, art_d, has_art, rg_d, has_rg].
  const p = 1 + shared.length + 4;
  const select = `SELECT split, decade, ${[...yCols, ...shared, ...meanCols, "has_art", "has_rg"].join(", ")} FROM imp_x`;
  const yAt = 2;
  const sharedAt = yAt + dims.length;
  const meanAt = sharedAt + shared.length;
  const hasAt = meanAt + meanCols.length;
  const x = new Float64Array(p);
  const fill = (row: readonly unknown[], d: number) => {
    x[0] = 1;
    for (let i = 0; i < shared.length; i++) x[1 + i] = Number(row[sharedAt + i] ?? 0);
    x[p - 4] = Number(row[meanAt + 2 * d] ?? 0);
    x[p - 3] = Number(row[hasAt] ?? 0);
    x[p - 2] = Number(row[meanAt + 2 * d + 1] ?? 0);
    x[p - 1] = Number(row[hasAt + 1] ?? 0);
  };

  const normals = dims.map(() => new Normal(p));
  let trainRows = 0;
  await forEachRow(db, `${select} WHERE split = ${SPLIT.train} ORDER BY gid`, (row) => {
    trainRows++;
    for (let d = 0; d < dims.length; d++) {
      const y = row[yAt + d];
      if (y === null || y === undefined) continue;
      fill(row, d);
      normals[d]?.add(x, Number(y));
    }
  });
  log(`  ridge: ${trainRows.toLocaleString("en")} training rows, ${p} features per dim`);
  const penalize = Array.from({ length: p }, (_, i) => i > 0);
  const betas = normals.map((n) => LAMBDAS.map((l) => solveRidge(n.full(), n.b, p, l, penalize)));
  const dot = (beta: Float64Array) => {
    let s = 0;
    for (let i = 0; i < p; i++) s += (beta[i] ?? 0) * (x[i] ?? 0);
    return Math.max(-1, Math.min(1, s));
  };

  // Validation picks λ per dim; test and artist-test rows measure the chosen model.
  const valErr = dims.map(() => LAMBDAS.map(() => 0));
  let valRows = 0;
  await forEachRow(db, `${select} WHERE split = ${SPLIT.val} ORDER BY gid`, (row) => {
    valRows++;
    for (let d = 0; d < dims.length; d++) {
      const yv = row[yAt + d];
      if (yv === null || yv === undefined) continue;
      fill(row, d);
      const y = Number(yv);
      LAMBDAS.forEach((_, li) => {
        const errs = valErr[d];
        if (errs)
          errs[li] = (errs[li] ?? 0) + Math.abs(dot(betas[d]?.[li] ?? new Float64Array(p)) - y);
      });
    }
  });
  const chosen = valErr.map((errs) => errs.indexOf(Math.min(...errs)));
  const report: Record<string, DimReport> = {};
  let testRows = 0;
  let artistTestRows = 0;
  const acc = dims.map(() => ({
    eR: 0,
    bR: 0,
    nR: 0,
    eA: 0,
    bA: 0,
    nA: 0,
    byDec: new Map<string, [number, number]>(),
  }));
  const means = normals.map((n) => n.sumY / Math.max(1, n.n));
  await forEachRow(
    db,
    `${select} WHERE split IN (${SPLIT.test}, ${SPLIT.artistTest}) ORDER BY gid`,
    (row) => {
      if (row[0] === SPLIT.test) testRows++;
      else artistTestRows++;
      dims.forEach((_, d) => {
        const a = acc[d];
        if (!a) return;
        const beta = betas[d]?.[chosen[d] ?? 0] ?? new Float64Array(p);
        const mean = means[d] ?? 0;
        const yv = row[yAt + d];
        if (yv === null || yv === undefined) return;
        fill(row, d);
        const y = Number(yv);
        const err = Math.abs(dot(beta) - y);
        if (row[0] === SPLIT.test) {
          a.eR += err;
          a.bR += Math.abs(mean - y);
          a.nR++;
          const key = String(row[1] ?? "unknown");
          const prev = a.byDec.get(key) ?? [0, 0];
          a.byDec.set(key, [prev[0] + err, prev[1] + 1]);
        } else {
          a.eA += err;
          a.bA += Math.abs(mean - y);
          a.nA++;
        }
      });
    },
  );
  dims.forEach((dim, d) => {
    const li = chosen[d] ?? 0;
    const a = acc[d] ?? {
      eR: 0,
      bR: 0,
      nR: 0,
      eA: 0,
      bA: 0,
      nA: 0,
      byDec: new Map<string, [number, number]>(),
    };
    report[dim] = {
      lambda: LAMBDAS[li] ?? 0,
      maeRandom: a.eR / Math.max(1, a.nR),
      baselineRandom: a.bR / Math.max(1, a.nR),
      maeArtist: a.eA / Math.max(1, a.nA),
      baselineArtist: a.bA / Math.max(1, a.nA),
      maeByDecade: Object.fromEntries([...a.byDec].sort().map(([k, [s, n]]) => [k, s / n])),
    };
  });

  // Predictions for target songs, as SQL linear expressions (exact same arithmetic for every row).
  const term = (beta: Float64Array, d: number) => {
    const names = ["1", ...shared, `art_${dims[d]}`, "has_art", `rg_${dims[d]}`, "has_rg"];
    return names.map((n, i) => `${(beta[i] ?? 0).toPrecision(17)} * ${n}`).join(" + ");
  };
  await db.run(`
    CREATE OR REPLACE TABLE dims_model AS
      SELECT song, has_art AS model_has_artist,
        ${dims.map((dim, d) => `greatest(-1, least(1, ${term(betas[d]?.[chosen[d] ?? 0] ?? new Float64Array(p), d)}))::DOUBLE AS ${dim}`).join(",\n        ")}
      FROM imp_x WHERE split = ${SPLIT.target};
  `);
  const predicted = await db.value<number>(`SELECT count(*) FROM dims_model`);
  return {
    trainRows,
    validationRows: valRows,
    testRows,
    artistTestRows,
    predicted,
    features: [...shared, "artist_mean", "has_artist", "release_group_mean", "has_release_group"],
    dims: report,
  };
}

/** Stream a query's rows (as value arrays) in result order. */
export async function forEachRow(
  db: Db,
  sql: string,
  fn: (row: readonly unknown[]) => void,
): Promise<void> {
  const result = await db.conn.stream(sql);
  for (;;) {
    const chunk = await result.fetchChunk();
    if (!chunk || chunk.rowCount === 0) break;
    for (const row of chunk.getRows()) fn(row as readonly unknown[]);
  }
}
