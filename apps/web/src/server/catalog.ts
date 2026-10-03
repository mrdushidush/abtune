import type { CatalogManifest } from "@abtune/catalog";
import type { LoadedCatalog } from "@abtune/catalog/reader";
import type { ApiError, CatalogHealth, CatalogLicense } from "../api-types.ts";

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

export type Ready =
  | { readonly ok: true; readonly catalog: LoadedCatalog }
  | { readonly ok: false; readonly status: 409 | 503; readonly body: ApiError };

/**
 * The loaded catalog, if a request made with these engine and catalog versions can use it: 503
 * while there is none or it is loading (with Retry-After), 409 on a version mismatch.
 */
export function readyCatalog(
  slot: CatalogSlot | null,
  versions: { readonly engine_version: string; readonly catalog_version: string },
  engine: string,
): Ready {
  if (!slot)
    return {
      ok: false,
      status: 503,
      body: {
        error: "no_catalog",
        message: "No music catalog is installed. Run `abtune catalog fetch`.",
      },
    };
  const state = slot.state;
  if (state.status === "loading")
    return {
      ok: false,
      status: 503,
      body: { error: "catalog_loading", message: "The catalog is still loading." },
    };
  if (state.status === "error")
    return {
      ok: false,
      status: 503,
      body: { error: "catalog_error", message: "The catalog failed to load." },
    };
  if (versions.engine_version !== engine || versions.catalog_version !== slot.info.version)
    return {
      ok: false,
      status: 409,
      body: {
        error: "version_mismatch",
        engine_version: engine,
        catalog_version: slot.info.version,
      },
    };
  return { ok: true, catalog: state.catalog };
}
