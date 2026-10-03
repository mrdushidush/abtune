import type { TasteVector, TweakSteps } from "@abtune/engine";

/** One playlist row as exported: catalog display data, never Spotify metadata. */
export interface ExportTrack {
  /** MusicBrainz recording MBID. */
  readonly track_id: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string | null;
  readonly year: number | null;
  readonly isrcs: readonly string[];
  readonly length_ms: number | null;
}

/** Everything an export needs. The profile is the taste vector + seed; raw answers never are. */
export interface ExportPlaylist {
  readonly title: string;
  readonly description: string;
  readonly catalog_version: string;
  readonly engine_version: string;
  readonly seed: string;
  readonly length: number;
  readonly taste: TasteVector;
  readonly tweaks: TweakSteps;
  readonly tracks: readonly ExportTrack[];
}

export const EXPORT_FORMATS = ["m3u", "csv", "xspf", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportFile {
  readonly filename: string;
  readonly mime: string;
  readonly content: string;
}

export const recordingUrl = (mbid: string) => `https://musicbrainz.org/recording/${mbid}`;

/** One line of free text: CR/LF and tabs become spaces (titles come from community data). */
export const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();
