// Where the open-data dumps live and how a build pins their versions (HANDOFF §6.2 stage 1).
// Layout and checksum formats verified against data.metabrainz.org on 2026-10-01.

export const METABRAINZ = "https://data.metabrainz.org/pub/musicbrainz";

export type SourceId =
  | "mb-core"
  | "mb-derived"
  | "canonical"
  | "lb-stats"
  | "ab-highlevel"
  | "ab-rhythm";

export const SOURCE_IDS: readonly SourceId[] = [
  "mb-core",
  "mb-derived",
  "canonical",
  "lb-stats",
  "ab-highlevel",
  "ab-rhythm",
];

/** One downloaded file, pinned by URL and sha256. */
export interface LockedFile {
  readonly source: SourceId;
  /** Path under the dumps directory, forward slashes. */
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  /** Dump date as published (YYYY-MM-DD). */
  readonly dumpDate: string;
}

/** `data/dumps/sources.lock.json`: the exact inputs of a build. */
export interface SourcesLock {
  readonly version: 1;
  readonly resolvedAt: string;
  readonly files: readonly LockedFile[];
}

export type FetchText = (url: string) => Promise<string>;

export const fetchText: FetchText = async (url) => {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.text();
};

export const USER_AGENT = "ABTune-catalog/0.1 (+https://github.com/mrdushidush/abtune)";

/** Entries of an nginx autoindex page (directories keep their trailing slash). */
export function listingEntries(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href="([^"?#]+)"/g)) {
    const name = decodeURIComponent(m[1] ?? "");
    if (name && name !== "../" && !name.startsWith("/") && !name.includes("://")) out.push(name);
  }
  return out;
}

/** Parse `sha256sum`-style lines ("<hex>  name" or "<hex> *name") into name → hash. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S.*)$/i.exec(line.trim());
    if (m?.[1] && m[2]) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

/** A bare `<file>.sha256` holds the hex digest, sometimes followed by the name. */
function parseSingleChecksum(text: string, url: string): string {
  const m = /^\s*([0-9a-f]{64})/i.exec(text);
  if (!m?.[1]) throw new Error(`No sha256 in ${url}`);
  return m[1].toLowerCase();
}

/** "20260930" → "2026-09-30". */
function isoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function newestFirst(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/** MusicBrainz full export: core (CC0) and derived (tags; CC BY-NC-SA) TSV dumps. */
export async function resolveMusicBrainz(get: FetchText = fetchText): Promise<LockedFile[]> {
  const base = `${METABRAINZ}/data/fullexport`;
  const dir = (await get(`${base}/LATEST`)).trim();
  if (!/^\d{8}-\d{6}$/.test(dir)) throw new Error(`Unexpected MusicBrainz LATEST: "${dir}"`);
  const sums = parseChecksums(await get(`${base}/${dir}/SHA256SUMS`));
  const files: [SourceId, string][] = [
    ["mb-core", "mbdump.tar.bz2"],
    ["mb-derived", "mbdump-derived.tar.bz2"],
  ];
  return files.map(([source, name]) => {
    const sha256 = sums.get(name);
    if (!sha256) throw new Error(`${name} missing from ${base}/${dir}/SHA256SUMS`);
    return {
      source,
      path: `musicbrainz/${dir}/${name}`,
      url: `${base}/${dir}/${name}`,
      sha256,
      dumpDate: isoDate(dir),
    };
  });
}

/** MusicBrainz canonical data (CC0): recording/release redirects to canonical versions. */
export async function resolveCanonical(get: FetchText = fetchText): Promise<LockedFile[]> {
  const base = `${METABRAINZ}/canonical_data`;
  const dirs = listingEntries(await get(`${base}/`))
    .filter((e) => /^musicbrainz-canonical-dump-\d{8}-\d{6}\/$/.test(e))
    .sort(newestFirst);
  const dir = dirs[0]?.slice(0, -1);
  if (!dir) throw new Error(`No canonical dumps listed at ${base}/`);
  const name = `${dir}.tar.zst`;
  const url = `${base}/${dir}/${name}`;
  return [
    {
      source: "canonical",
      path: `canonical/${name}`,
      url,
      sha256: parseSingleChecksum(await get(`${url}.sha256`), `${url}.sha256`),
      dumpDate: isoDate(dir.slice("musicbrainz-canonical-dump-".length)),
    },
  ];
}

/**
 * ListenBrainz statistics dump (CC0): per-user top-1000 artists/recordings. Full exports
 * upload over days, so take the newest one whose statistics file and checksum are both up.
 */
export async function resolveListenBrainzStats(get: FetchText = fetchText): Promise<LockedFile[]> {
  const base = `${METABRAINZ}/listenbrainz/fullexport`;
  const dirs = listingEntries(await get(`${base}/`))
    .filter((e) => /^listenbrainz-dump-\d+-\d{8}-\d{6}-full\/$/.test(e))
    .sort((a, b) =>
      newestFirst(
        a.replace(/^listenbrainz-dump-\d+-/, ""),
        b.replace(/^listenbrainz-dump-\d+-/, ""),
      ),
    );
  for (const entry of dirs) {
    const dir = entry.slice(0, -1);
    const names = listingEntries(await get(`${base}/${dir}/`));
    const name = names.find((n) => /^listenbrainz-statistics-dump-\d{8}-\d{6}\.tar\.zst$/.test(n));
    if (!name || !names.includes(`${name}.sha256`)) continue;
    const url = `${base}/${dir}/${name}`;
    return [
      {
        source: "lb-stats",
        path: `listenbrainz/${name}`,
        url,
        sha256: parseSingleChecksum(await get(`${url}.sha256`), `${url}.sha256`),
        dumpDate: isoDate(
          name.slice("listenbrainz-statistics-dump-".length, -"-000000.tar.zst".length),
        ),
      },
    ];
  }
  throw new Error(`No complete ListenBrainz statistics dump under ${base}/`);
}

export const AB_DUMP_DATE = "20220623";

/** AcousticBrainz final dumps (CC0, frozen 2022): high-level JSON parts and rhythm features. */
export async function resolveAcousticBrainz(get: FetchText = fetchText): Promise<LockedFile[]> {
  const base = `${METABRAINZ}/acousticbrainz/dumps`;
  const hlDir = `acousticbrainz-highlevel-json-${AB_DUMP_DATE}`;
  const ftDir = `acousticbrainz-lowlevel-features-${AB_DUMP_DATE}`;
  const hl = parseChecksums(await get(`${base}/${hlDir}/sha256sums`));
  const ft = parseChecksums(await get(`${base}/${ftDir}/sha256sums`));
  const part = (n: string) => Number(/-(\d+)\.tar\.zst$/.exec(n)?.[1] ?? Number.NaN);
  const parts = [...hl.keys()]
    .filter((n) => Number.isInteger(part(n)))
    .sort((a, b) => part(a) - part(b));
  if (parts.length === 0) throw new Error(`No high-level parts in ${base}/${hlDir}/sha256sums`);
  const date = isoDate(AB_DUMP_DATE);
  const files: LockedFile[] = parts.map((name) => ({
    source: "ab-highlevel",
    path: `acousticbrainz/${name}`,
    url: `${base}/${hlDir}/${name}`,
    sha256: hl.get(name) ?? "",
    dumpDate: date,
  }));
  const rhythm = `${ftDir}-rhythm.tar.zst`;
  const rhythmSha = ft.get(rhythm);
  if (!rhythmSha) throw new Error(`${rhythm} missing from ${base}/${ftDir}/sha256sums`);
  files.push({
    source: "ab-rhythm",
    path: `acousticbrainz/${rhythm}`,
    url: `${base}/${ftDir}/${rhythm}`,
    sha256: rhythmSha,
    dumpDate: date,
  });
  return files;
}

const RESOLVERS: Record<string, (get: FetchText) => Promise<LockedFile[]>> = {
  musicbrainz: resolveMusicBrainz,
  canonical: resolveCanonical,
  listenbrainz: resolveListenBrainzStats,
  acousticbrainz: resolveAcousticBrainz,
};

/** Resolve the newest version of every source. */
export async function resolveSources(
  get: FetchText = fetchText,
  now = new Date(),
): Promise<SourcesLock> {
  const files: LockedFile[] = [];
  for (const resolve of Object.values(RESOLVERS)) files.push(...(await resolve(get)));
  return { version: 1, resolvedAt: now.toISOString(), files };
}
