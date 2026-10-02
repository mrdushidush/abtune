// Catalog manifest and license notice, shared by the full catalog, the dev sample and the fixture.
import type { SourceId } from "./sources.ts";

/** Bump when tracks.parquet columns or their meaning change. */
export const CATALOG_SCHEMA_VERSION = 1;

export interface CatalogLicense {
  readonly id: string;
  readonly url: string;
  readonly reason: string;
  readonly attribution: string;
}

/**
 * The catalog derives genre clusters from MusicBrainz tags, which ship in mbdump-derived under
 * CC BY-NC-SA 3.0 US (its COPYING, verified at extraction). The most restrictive input wins (§6.9).
 */
export const CATALOG_LICENSE: CatalogLicense = {
  id: "CC-BY-NC-SA-3.0-US",
  url: "https://creativecommons.org/licenses/by-nc-sa/3.0/us/",
  reason:
    "Genre clusters are derived from MusicBrainz tags (supplementary data, CC BY-NC-SA 3.0 US). " +
    "All other inputs (MusicBrainz core and canonical data, ListenBrainz, AcousticBrainz) are CC0.",
  attribution:
    "Contains data from MusicBrainz (https://musicbrainz.org), ListenBrainz (https://listenbrainz.org) " +
    "and AcousticBrainz (https://acousticbrainz.org), MetaBrainz Foundation.",
};

export interface CatalogManifest {
  readonly name: "abtune-catalog";
  readonly catalog_version: string;
  readonly schema_version: number;
  /** full: the ~2M build; dev-sample: 50k download; fixture: 5k committed test data. */
  readonly kind: "full" | "dev-sample" | "fixture";
  readonly tracks: number;
  /** sha256 over the rows (see digestSql); identical content ⇔ identical digest. */
  readonly digest: string;
  readonly created_at: string;
  readonly license: CatalogLicense;
  readonly sources: readonly { source: SourceId; url: string; sha256: string; dumpDate: string }[];
  readonly popularity: { readonly api: boolean; readonly snapshot: string | null };
  readonly config: Record<string, unknown>;
  readonly dimensions: {
    readonly genres: readonly string[];
    readonly decades: readonly string[];
    readonly languages: readonly string[];
  };
  readonly files: readonly {
    readonly name: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  /** For samples: the catalog they were drawn from. */
  readonly derived_from?: {
    readonly catalog_version: string;
    readonly digest: string;
    readonly tracks: number;
  };
}

export function licenseText(m: CatalogManifest): string {
  return `# ABTune catalog ${m.catalog_version} (${m.kind}) — data license

This data set is licensed under **${m.license.id}**: ${m.license.url}

${m.license.reason}

${m.license.attribution}

You may share and adapt it for non-commercial purposes, with attribution, under the same license.
The ABTune source code that builds it is MIT-licensed; see docs/DATA_LICENSES.md in the repository.
`;
}
