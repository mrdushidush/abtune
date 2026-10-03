import type { CatalogManifest } from "@abtune/catalog";
import type { LoadedCatalog } from "@abtune/catalog/reader";
import type { CatalogHealth, CatalogLicense } from "../api-types.ts";

/** What the manifest says about the installed catalog (known before its columns load). */
export interface CatalogInfo {
  readonly version: string;
  readonly kind: string;
  readonly tracks: number;
  readonly license: CatalogLicense | null;
}

export type SlotState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly catalog: LoadedCatalog }
  | { readonly status: "error"; readonly message: string };

/**
 * The server's catalog. Columns load in the background (~8 s for the full 2M catalog), so the
 * server answers health checks at once and playlist requests get 503 until the slot is ready.
 */
export interface CatalogSlot {
  readonly info: CatalogInfo;
  readonly state: SlotState;
  /** Settles when loading ends either way. */
  readonly settled: Promise<void>;
}

export function catalogInfo(manifest: CatalogManifest): CatalogInfo {
  const l = manifest.license as Partial<CatalogLicense> | undefined;
  return {
    version: manifest.catalog_version,
    kind: manifest.kind,
    tracks: manifest.tracks,
    license:
      l?.id && l.url && l.attribution ? { id: l.id, url: l.url, attribution: l.attribution } : null,
  };
}

export function catalogSlot(info: CatalogInfo, loading: Promise<LoadedCatalog>): CatalogSlot {
  const slot: { info: CatalogInfo; state: SlotState; settled: Promise<void> } = {
    info,
    state: { status: "loading" },
    settled: Promise.resolve(),
  };
  slot.settled = loading.then(
    (catalog) => {
      slot.state = { status: "ready", catalog };
    },
    (err: unknown) => {
      slot.state = { status: "error", message: err instanceof Error ? err.message : String(err) };
    },
  );
  return slot;
}

export function catalogHealth(slot: CatalogSlot | null): CatalogHealth | null {
  return slot ? { ...slot.info, status: slot.state.status } : null;
}
