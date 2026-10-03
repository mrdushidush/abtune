import { type Bank, engineVersion, type SessionState, type TweakSteps } from "@abtune/engine";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Health, PlaylistRequest, PlaylistResponse } from "../../api-types.ts";
import { buildPlaylistRequest, fetchHealth, postPlaylist } from "./api.ts";

export type HealthState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly health: Health }
  | { readonly kind: "down" };

export function useHealth(): [HealthState, () => void] {
  const [state, setState] = useState<HealthState>({ kind: "loading" });
  const refresh = useCallback(() => {
    fetchHealth().then((r) => setState(r.ok ? { kind: "ok", health: r.data } : { kind: "down" }));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return [state, refresh];
}

export type PlaylistState =
  | { readonly kind: "waiting" }
  | { readonly kind: "loading"; readonly previous: PlaylistResponse | null }
  | { readonly kind: "ready"; readonly data: PlaylistResponse; readonly request: PlaylistRequest }
  | { readonly kind: "no_catalog" }
  | { readonly kind: "catalog_loading" }
  | { readonly kind: "catalog_error" }
  | { readonly kind: "stale" }
  | { readonly kind: "down" };

const POLL_MS = 2000;

/**
 * Fetch the playlist for a finished session whenever its inputs change (reshuffle, tweak, 10 more).
 * Tracks the server's catalog status and asks for a reload if the server runs another engine.
 */
export function usePlaylist(
  bank: Bank,
  session: SessionState,
  tweaks: TweakSteps,
  health: HealthState,
  refreshHealth: () => void,
): { state: PlaylistState; retry: () => void } {
  const [state, setState] = useState<PlaylistState>({ kind: "waiting" });
  const last = useRef<PlaylistResponse | null>(null);
  const [attempt, setAttempt] = useState(0);

  const h = health.kind === "ok" ? health.health : null;
  const stale = h !== null && h.engine_version !== engineVersion(bank);
  const catalog = h?.catalog ?? null;
  const request = useMemo(
    () =>
      catalog?.status === "ready" && !stale
        ? buildPlaylistRequest(bank, session, tweaks, catalog.version)
        : null,
    [bank, session, tweaks, catalog?.status, catalog?.version, stale],
  );
  const key = request ? JSON.stringify(request) : null;

  // Status that needs no request.
  useEffect(() => {
    if (health.kind === "loading") return setState({ kind: "waiting" });
    if (health.kind === "down") return setState({ kind: "down" });
    if (stale) return setState({ kind: "stale" });
    if (!catalog) return setState({ kind: "no_catalog" });
    if (catalog.status === "error") return setState({ kind: "catalog_error" });
    if (catalog.status === "loading") {
      setState({ kind: "catalog_loading" });
      const id = setTimeout(refreshHealth, POLL_MS);
      return () => clearTimeout(id);
    }
  }, [health, stale, catalog, refreshHealth]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `request`; `attempt` retries
  useEffect(() => {
    if (!request) return;
    const abort = new AbortController();
    setState({ kind: "loading", previous: last.current });
    postPlaylist(request, abort.signal).then((r) => {
      if (abort.signal.aborted) return;
      if (r.ok) {
        last.current = r.data;
        return setState({ kind: "ready", data: r.data, request });
      }
      if (
        r.status === 409 ||
        r.error?.error === "catalog_loading" ||
        r.error?.error === "no_catalog"
      )
        return refreshHealth();
      if (r.error?.error === "catalog_error") return setState({ kind: "catalog_error" });
      setState({ kind: "down" });
    });
    return () => abort.abort();
  }, [key, attempt]);

  const retry = useCallback(() => {
    refreshHealth();
    setAttempt((n) => n + 1);
  }, [refreshHealth]);
  return { state, retry };
}
