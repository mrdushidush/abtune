import type { ExportPlaylist } from "./types.ts";

export const CSV_HEADER = ["Title", "Artist", "Album", "Year", "ISRC", "MusicBrainz ID"] as const;

/**
 * Spreadsheet formula injection: a cell starting with one of these runs as a formula when the CSV is
 * opened in Excel or Sheets, so it gets a leading apostrophe.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvField(value: string): string {
  const v = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC 4180 (CRLF, quoted where needed), UTF-8 without a BOM. One row per track, first ISRC. */
export function toCSV(p: ExportPlaylist): string {
  const rows = [CSV_HEADER.map(csvField).join(",")];
  for (const t of p.tracks) {
    rows.push(
      [t.title, t.artist, t.album ?? "", t.year?.toString() ?? "", t.isrcs[0] ?? "", t.track_id]
        .map(csvField)
        .join(","),
    );
  }
  return `${rows.join("\r\n")}\r\n`;
}
