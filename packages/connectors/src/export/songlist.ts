import { type ExportTrack, oneLine } from "./types.ts";

/**
 * One "Artist - Title" per line, the plain song list that playlist-transfer sites read when pasted
 * (TuneMyMusic's "Free text": "The Beatles - Hey Jude"). No title line: it would read as a song.
 */
export function toSongList(tracks: readonly Pick<ExportTrack, "artist" | "title">[]): string {
  return tracks.map((t) => `${oneLine(t.artist)} - ${oneLine(t.title)}\n`).join("");
}
