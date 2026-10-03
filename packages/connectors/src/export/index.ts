import { toCSV } from "./csv.ts";
import { toJSON } from "./json.ts";
import { toM3U } from "./m3u.ts";
import type { ExportFile, ExportFormat, ExportPlaylist } from "./types.ts";
import { toXSPF } from "./xspf.ts";

export * from "./csv.ts";
export * from "./json.ts";
export * from "./m3u.ts";
export * from "./types.ts";
export * from "./xspf.ts";

const FORMATS: Record<
  ExportFormat,
  { ext: string; mime: string; write: (p: ExportPlaylist) => string }
> = {
  m3u: { ext: "m3u8", mime: "audio/x-mpegurl;charset=utf-8", write: toM3U },
  csv: { ext: "csv", mime: "text/csv;charset=utf-8", write: toCSV },
  xspf: { ext: "xspf", mime: "application/xspf+xml;charset=utf-8", write: toXSPF },
  json: { ext: "json", mime: "application/json;charset=utf-8", write: toJSON },
};

const SLUG_MAX = 60;

/** ASCII file name stem from a title ("Neon Nostalgist · Synth & New Wave 80s" → "neon-nostalgist-synth-new-wave-80s"). */
export function slug(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, "");
  return s || "abtune-playlist";
}

/** HANDOFF §11.2: a playlist as a file. Pure; the caller saves or downloads it. */
export function exportPlaylist(format: ExportFormat, playlist: ExportPlaylist): ExportFile {
  const f = FORMATS[format];
  if (!f) throw new Error(`Unknown export format "${String(format)}"`);
  return { filename: `${slug(playlist.title)}.${f.ext}`, mime: f.mime, content: f.write(playlist) };
}
