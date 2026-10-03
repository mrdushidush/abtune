// data/eval/canon.tsv: widely known hits, for the canon recognition metric (owner decision D1).
import { readFile } from "node:fs/promises";

export const CANON_FILE = "data/eval/canon.tsv";

export interface CanonSong {
  readonly market: string;
  /** Artist credit alternatives (a match contains one). */
  readonly artists: readonly string[];
  /** Title alternatives (a match equals one, normalized). */
  readonly titles: readonly string[];
}

/** Parse the TSV: `market \t artists \t titles`, alternatives comma-separated, `#` comments. */
export function parseCanon(text: string): CanonSong[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.startsWith("#"))
    .map((l, k) => {
      const [market, artists, titles] = l.split("\t");
      if (!market || !artists || !titles) throw new Error(`canon line ${k + 1}: want 3 columns`);
      const alts = (x: string) =>
        x
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean);
      return { market, artists: alts(artists), titles: alts(titles) };
    });
}

export async function readCanon(file = CANON_FILE): Promise<CanonSong[]> {
  return parseCanon(await readFile(file, "utf8"));
}
