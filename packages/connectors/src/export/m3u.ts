import { type ExportPlaylist, oneLine, recordingUrl } from "./types.ts";

/**
 * Extended M3U, UTF-8 (hence `.m3u8`): `#EXTINF:<seconds>,<artist> - <title>`, then the
 * MusicBrainz recording URL as the entry's location (there is no local file to point at).
 */
export function toM3U(p: ExportPlaylist): string {
  const lines = ["#EXTM3U", `#PLAYLIST:${oneLine(p.title)}`];
  for (const t of p.tracks) {
    const seconds = t.length_ms === null ? -1 : Math.round(t.length_ms / 1000);
    lines.push(`#EXTINF:${seconds},${oneLine(t.artist)} - ${oneLine(t.title)}`);
    lines.push(recordingUrl(t.track_id));
  }
  return `${lines.join("\n")}\n`;
}
