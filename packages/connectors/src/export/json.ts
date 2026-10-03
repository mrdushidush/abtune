import type { ExportPlaylist } from "./types.ts";

export const JSON_FORMAT = "abtune.playlist";
export const JSON_FORMAT_VERSION = 1;

/**
 * The full export: playlist plus the profile that made it (taste vector, tweaks, seed, versions).
 * With the same catalog and engine, `taste` + `seed` + `length` regenerate the exact track list.
 */
export function toJSON(p: ExportPlaylist): string {
  return `${JSON.stringify(
    {
      format: JSON_FORMAT,
      version: JSON_FORMAT_VERSION,
      title: p.title,
      description: p.description,
      catalog_version: p.catalog_version,
      engine_version: p.engine_version,
      seed: p.seed,
      length: p.length,
      taste: p.taste,
      tweaks: p.tweaks,
      tracks: p.tracks,
    },
    null,
    2,
  )}\n`;
}
