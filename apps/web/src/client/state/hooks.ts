import { type Bank, engineVersion, type SessionState, type TweakSteps } from "@abtune/engine";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Health, PlaylistRequest, PlaylistResponse } from "../../api-types.ts";
import { type AiView, failureOf, interpretRequest, postInterpret } from "./ai.ts";
import {
  type AiRequestParts,
  buildPlaylistRequest,
  fetchHealth,
  postPlaylist,
  retryAfterMs,
} from "./api.ts";
import type { AiState, AppAction } from "./app.ts";

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
  /** Rate limited (429): asks again by itself once the server allows it. */
  | { readonly kind: "busy" }
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
  /** The AI layer's part; `hold` while T1 is still reading the answers. */
  ai: AiRequestParts & { readonly hold?: boolean } = {},
): { state: PlaylistState; retry: () => void } {
  const [state, setState] = useState<PlaylistState>({ kind: "waiting" });
  const last = useRef<PlaylistResponse | null>(null);
  const [attempt, setAttempt] = useState(0);

  const h = health.kind === "ok" ? health.health : null;
  const stale = h !== null && h.engine_version !== engineVersion(bank);
  const catalog = h?.catalog ?? null;
  const { hold, base, rerank, context } = ai;
  const request = useMemo(
    () =>
      catalog?.status === "ready" && !stale && !hold
        ? buildPlaylistRequest(bank, session, tweaks, catalog.version, { base, rerank, context })
        : null,
    [bank, session, tweaks, catalog?.status, catalog?.version, stale, hold, base, rerank, context],
  );
  const key = request ? JSON.stringify(request) : null;

  // Status that needs no request.
  useEffect(() => {
    if (health.kind === "loading" || hold) return setState({ kind: "waiting" });
    if (health.kind === "down") return setState({ kind: "down" });
    if (stale) return setState({ kind: "stale" });
    if (!catalog) return setState({ kind: "no_catalog" });
    if (catalog.status === "error") return setState({ kind: "catalog_error" });
    if (catalog.status === "loading") {
      setState({ kind: "catalog_loading" });
      const id = setTimeout(refreshHealth, POLL_MS);
      return () => clearTimeout(id);
    }
  }, [health, stale, catalog, refreshHealth, hold]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `request`; `attempt` retries
  useEffect(() => {
    if (!request) return;
    const abort = new AbortController();
    let wait: ReturnType<typeof setTimeout> | undefined;
    setState({ kind: "loading", previous: last.current });
    postPlaylist(request, abort.signal).then((r) => {
      if (abort.signal.aborted) return;
      if (r.ok) {
        last.current = r.data;
        return setState({ kind: "ready", data: r.data, request });
      }
      if (r.status === 429) {
        setState({ kind: "busy" });
        wait = setTimeout(() => setAttempt((n) => n + 1), retryAfterMs(r.error));
        return;
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
    return () => {
      abort.abort();
      clearTimeout(wait);
    };
  }, [key, attempt]);

  const retry = useCallback(() => {
    refreshHealth();
    setAttempt((n) => n + 1);
  }, [refreshHealth]);
  return { state, retry };
}

/**
 * T1 Interpret (HANDOFF §10.2) for a finished session with AI on: once per answer log, then kept
 * in the app state (and localStorage), so a reload or reshuffle never asks again. A failure is
 * kept too: the classic playlist shows, with a notice.
 */
export function useAiInterpret(
  bank: Bank,
  session: SessionState,
  ai: AiState | null,
  view: AiView,
  dispatch: (a: AppAction) => void,
): void {
  const { pending, key } = view;
  const optIn = ai?.optIn ?? false;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the answers
  useEffect(() => {
    if (!pending) return;
    const abort = new AbortController();
    postInterpret(interpretRequest(bank, session, optIn), abort.signal).then((r) => {
      if (abort.signal.aborted) return;
      dispatch({
        type: "ai_interpret",
        key,
        result: r.ok
          ? {
              status: "done",
              adjust: r.data.adjust,
              title: r.data.title,
              blurb: r.data.blurb,
              sensitive: (r.data.sent?.sensitive ?? 0) > 0,
            }
          : { status: "failed", reason: failureOf(r.error) },
      });
    });
    return () => abort.abort();
  }, [pending, key, optIn]);
}
