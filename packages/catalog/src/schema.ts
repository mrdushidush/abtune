// One catalog row (HANDOFF §6.5 plus extras), as the fixture stores it and M3 reads it.
import { z } from "zod";

const unit = z.number().min(-1).max(1);

export const catalogTrackSchema = z.object({
  track_id: z.uuid(),
  title: z.string(),
  artist_credit: z.string(),
  artist_mbids: z.array(z.uuid()).min(1),
  release_title: z.string().nullable(),
  year: z.number().int().nullable(),
  decade: z.string().nullable(),
  isrcs: z.array(z.string()),
  language: z.string(),
  clusters: z.record(z.string(), z.number().min(0).max(1)),
  primary_cluster: z.string().nullable(),
  energy: unit,
  valence: unit,
  dance: unit,
  acoustic: unit,
  intensity: unit,
  tempo: unit,
  mainstream: unit,
  vocal: unit,
  complexity: unit,
  feature_source: z.enum(["ab_direct", "ab_sibling", "model", "ai"]),
  feature_confidence: z.number().min(0).max(1),
  listeners: z.number().int().nonnegative(),
  listens: z.number().int().nonnegative(),
  popularity_pct: z.number().min(0).max(1),
  catalog_version: z.string(),
  artist_country: z.string().nullable(),
  language_iso: z.string().nullable(),
  length_ms: z.number().int().nullable(),
  version_type: z.string(),
  genre_source: z.string(),
  raw_energy: z.number(),
  raw_valence: z.number(),
  raw_dance: z.number(),
  raw_acoustic: z.number(),
  raw_intensity: z.number(),
  raw_tempo: z.number(),
  raw_vocal: z.number(),
  raw_complexity: z.number(),
  raw_bpm: z.number().nullable(),
  selected_via: z.string(),
  /** ListenBrainz users with the song in their all-time top 1000 (the hit signal). */
  proxy_listeners: z.number().int().nonnegative(),
  /** Release groups holding the song; how many are compilations; how many by Various Artists. */
  release_groups: z.number().int().nonnegative(),
  comps: z.number().int().nonnegative(),
  va_comps: z.number().int().nonnegative(),
  /** `il`: ranked among Israeli songs (curated artists, Hebrew songs by Israeli artists). */
  market: z.enum(["il", "intl"]),
  /** 1 = the first artist's best-known song. */
  artist_rank: z.number().int().positive(),
  /** Hit-key percentile within (decade, market); 1 = the best-known. */
  hit_pct: z.number().min(0).max(1),
  /** 0 = hits view, 1 = deep cut by an artist with a hit, 2 = long tail. */
  tier: z.number().int().min(0).max(2),
});

export type CatalogTrack = z.infer<typeof catalogTrackSchema>;

/** The scalar feature columns, in bank declaration order. */
export const SCALAR_COLUMNS = [
  "energy",
  "valence",
  "dance",
  "acoustic",
  "intensity",
  "tempo",
  "mainstream",
  "vocal",
  "complexity",
] as const;
