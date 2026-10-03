// Which installed catalog the app uses: CATALOG_PATH if set, else the best one under data/catalog.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CATALOG_SCHEMA_VERSION, type CatalogManifest } from "./manifest.ts";

export interface InstalledCatalog {
  readonly dir: string;
  readonly manifest: CatalogManifest;
}

async function readManifest(dir: string): Promise<CatalogManifest | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as CatalogManifest;
  } catch {
    return undefined;
  }
}

const KIND_RANK: Record<CatalogManifest["kind"], number> = { full: 2, "dev-sample": 1, fixture: 0 };

/**
 * `explicit` (CATALOG_PATH) wins and must contain a manifest. Otherwise prefer a full build over
 * a dev sample, then the newest version (by name), among catalogs of this code's schema (an older
 * download left in place is skipped). Undefined when nothing is installed.
 */
export async function findCatalog(
  root: string,
  explicit?: string,
): Promise<InstalledCatalog | undefined> {
  if (explicit) {
    const manifest = await readManifest(explicit);
    if (!manifest) throw new Error(`CATALOG_PATH=${explicit} has no manifest.json`);
    return { dir: explicit, manifest };
  }
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return undefined;
  }
  const found: InstalledCatalog[] = [];
  for (const name of names) {
    const manifest = await readManifest(path.join(root, name));
    if (manifest?.name === "abtune-catalog" && manifest.schema_version === CATALOG_SCHEMA_VERSION)
      found.push({ dir: path.join(root, name), manifest });
  }
  found.sort(
    (a, b) =>
      KIND_RANK[b.manifest.kind] - KIND_RANK[a.manifest.kind] ||
      (a.manifest.catalog_version < b.manifest.catalog_version
        ? 1
        : a.manifest.catalog_version > b.manifest.catalog_version
          ? -1
          : 0) ||
      (a.dir < b.dir ? -1 : 1),
  );
  return found[0];
}
