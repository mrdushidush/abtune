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
  /**
   * Opt-in languages (owner decisions 2026-10-04): a listed language needs a reason. It is left
   * out when the answers carry no language evidence at all, and when the listener's top language
   * has at least `avoidRatio` times its share: a clear lean away, such as "English, mostly" (2.7×)
   * or "Mostly international" (2.5×), while picking an Israeli artist on top keeps Hebrew
   * (≤ 2.0×). Every Israeli-pack card carries Hebrew evidence. Dropped when relaxing to fill.
   */
  readonly avoidLanguages: readonly string[];
  readonly avoidRatio: number;
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
  /**
   * Popularity tiers (owner decision D6): a popularity target t ≥ hitsAbove draws from the hits view
   * only; t ≥ deepAbove adds deep cuts by artists with a hit; below that, the whole catalog. A
   * playlist that can't fill widens one tier at a time before relaxing genres or language.
   */
  readonly hitsAbove: number;
  readonly deepAbove: number;
  /**
   * Familiarity window: a cell picks only from the best-known tracks of each (primary cluster,
   * decade, market) group of its allowed tiers: max(familiarityPool × its pool size,
   * familiarityShare × the group) × familiarityRatio^(−t), never fewer than the pool itself. It
   * widens (doubling) when it runs dry. familiarityPool 0 turns it off. A playlist that starts from
   * the whole long tail ("Hidden gems") has no window.
   */
  readonly familiarityPool: number;
  readonly familiarityShare: number;
  readonly familiarityRatio: number;
}

/** The brief's §9.1 start, tuned with the persona eval (M3, see DECISIONS.md): wLanguage 0.1 → 0.2, languageNeutral 0.5 → 0.25. */
export const DEFAULT_GENERATOR_PARAMS: GeneratorParams = {
  wScalar: 0.45,
  wGenre: 0.3,
  wDecade: 0.15,
  wLanguage: 0.2,
  languageNeutral: 0.25,
  languageHardFilter: 0.8,
  avoidLanguages: ["lang_he"],
  avoidRatio: 2.4,
  prefilterMass: 0.9,
  cellMass: 0.9,
  poolFactor: 3,
  temperature: 0.1,
  mmrLambda: 0.15,
  artistCap: 2,
  shortArtistCap: 1,
  shortLength: 25,
  tempoLambda: 0.3,
  hitsAbove: 0,
  deepAbove: -0.5,
  familiarityPool: 3,
  familiarityShare: 0.004,
  familiarityRatio: 4,
};

/** §9.3: max tracks per artist for a playlist of `length`. */
export function artistCap(length: number, params: GeneratorParams): number {
  return length <= params.shortLength ? params.shortArtistCap : params.artistCap;
}
