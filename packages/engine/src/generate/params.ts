/** Playlist generation constants (HANDOFF §9). Changing any of them changes playlists: bump ENGINE_SEMVER. */
export interface GeneratorParams {
  /** §9.1 component weights: scalar fit, genre, decade (era), language. */
  readonly wScalar: number;
  readonly wGenre: number;
  readonly wDecade: number;
  readonly wLanguage: number;
  /** L(t) for instrumental and unknown-language tracks (they are neither a hit nor a miss). */
  readonly languageNeutral: number;
  /** One language with p ≥ this becomes a hard filter (§7.3). */
  readonly languageHardFilter: number;
  /** §9.2.1: keep clusters / decades covering this share of their group's mass. */
  readonly prefilterMass: number;
  /** §9.2.2: keep cells until their cumulative weight reaches this share. */
  readonly cellMass: number;
  /** §9.2.3: sample each cell's picks from its top `poolFactor × slots` tracks. */
  readonly poolFactor: number;
  /** §9.2.3: softmax temperature over the [0, 1] score. */
  readonly temperature: number;
  /** MMR: penalty × similarity to the closest track already picked. */
  readonly mmrLambda: number;
  /** §9.3: tracks per artist, and the tighter cap for short playlists. */
  readonly artistCap: number;
  readonly shortArtistCap: number;
  readonly shortLength: number;
  /** §9.4: weight of |Δtempo| against the energy-curve error when sequencing. */
  readonly tempoLambda: number;
}

/** The brief's §9.1 start, tuned with the persona eval (M3, see DECISIONS.md): wLanguage 0.1 → 0.2, languageNeutral 0.5 → 0.25. */
export const DEFAULT_GENERATOR_PARAMS: GeneratorParams = {
  wScalar: 0.45,
  wGenre: 0.3,
  wDecade: 0.15,
  wLanguage: 0.2,
  languageNeutral: 0.25,
  languageHardFilter: 0.8,
  prefilterMass: 0.9,
  cellMass: 0.9,
  poolFactor: 3,
  temperature: 0.1,
  mmrLambda: 0.15,
  artistCap: 2,
  shortArtistCap: 1,
  shortLength: 25,
  tempoLambda: 0.3,
};

/** §9.3: max tracks per artist for a playlist of `length`. */
export function artistCap(length: number, params: GeneratorParams): number {
  return length <= params.shortLength ? params.shortArtistCap : params.artistCap;
}
