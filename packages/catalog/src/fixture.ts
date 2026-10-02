// The committed 5k-track test fixture (data/catalog-fixture), for tests that need real catalog
// rows without DuckDB or a download (HANDOFF §5.2: CatalogReader over the 5k fixture).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { CatalogManifest } from "./manifest.ts";
import { type CatalogTrack, catalogTrackSchema } from "./schema.ts";

export const FIXTURE_DIR = fileURLToPath(new URL("../../../data/catalog-fixture", import.meta.url));

export interface Fixture {
  readonly manifest: CatalogManifest;
  readonly tracks: readonly CatalogTrack[];
  /** The uncompressed JSONL text (its sha256 is manifest.digest). */
  readonly text: string;
}

export async function readFixture(dir = FIXTURE_DIR, validate = false): Promise<Fixture> {
  const manifest = JSON.parse(
    await readFile(path.join(dir, "manifest.json"), "utf8"),
  ) as CatalogManifest;
  const text = gunzipSync(await readFile(path.join(dir, "tracks.jsonl.gz"))).toString("utf8");
  const tracks = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as unknown;
      return validate ? catalogTrackSchema.parse(row) : (row as CatalogTrack);
    });
  return { manifest, tracks, text };
}
