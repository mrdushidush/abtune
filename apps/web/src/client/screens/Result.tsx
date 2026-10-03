import { type ExportFormat, type ExportPlaylist, exportPlaylist } from "@abtune/connectors";
import {
  type Bank,
  playlistTitle,
  type SessionState,
  TWEAK_AXES,
  type TweakSteps,
  tasteVector,
  viewSession,
} from "@abtune/engine";
import { useMemo, useState } from "react";
import type { PlaylistRequest, PlaylistResponse, PlaylistTrackOut } from "../../api-types.ts";
import { PersonalityCard } from "../components/PersonalityCard.tsx";
import { PlaylistRows, SkeletonRows } from "../components/PlaylistRows.tsx";
import { ExportMenu, Feedback, TweakBar } from "../components/ResultActions.tsx";
import { download } from "../lib/download.ts";
import { MORE_LENGTH, moreRequest, postPlaylist, swapRequest } from "../state/api.ts";
import type { AppAction } from "../state/app.ts";
import { recordVote, type Vote, voteFor } from "../state/feedback.ts";
import { type HealthState, type PlaylistState, usePlaylist } from "../state/hooks.ts";
import { t, tweakSummary } from "../strings.ts";

function tweakNames(steps: TweakSteps): string[] {
  return TWEAK_AXES.filter((a) => (steps[a] ?? 0) !== 0).map((a) => tweakSummary(a, steps[a] ?? 0));
}

function toExport(
  title: string,
  description: string,
  data: PlaylistResponse,
  request: PlaylistRequest,
  tweaks: TweakSteps,
  tracks: readonly PlaylistTrackOut[],
): ExportPlaylist {
  return {
    title,
    description,
    catalog_version: data.catalog_version,
    engine_version: data.engine_version,
    seed: data.seed,
    length: tracks.length,
    taste: request.taste,
    tweaks,
    tracks: tracks.map((tr) => ({
      track_id: tr.track_id,
      title: tr.title,
      artist: tr.artist,
      album: tr.album,
      year: tr.year,
      isrcs: tr.isrcs,
      length_ms: tr.length_ms,
    })),
  };
}

function Notice({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-6 text-center text-text-2">
      {children}
      {action && (
        <button
          type="button"
          className="rounded-xl bg-raised px-4 py-2 font-semibold text-text hover:bg-line"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function PlaylistBody({
  state,
  length,
  retry,
  tracks,
  onSwap,
  swapping,
}: {
  state: PlaylistState;
  length: number;
  retry: () => void;
  /** What's on screen when ready: the playlist plus appended pages and swaps. */
  tracks: readonly PlaylistTrackOut[];
  onSwap: (i: number) => void;
  swapping: number | null;
}) {
  switch (state.kind) {
    case "ready":
      return (
        <>
          {state.data.warnings.includes("catalog_exhausted") && (
            <p className="text-sm text-text-3">{t.result.shortPlaylist}</p>
          )}
          <PlaylistRows tracks={tracks} onSwap={onSwap} swapping={swapping} />
        </>
      );
    case "loading":
      return state.previous ? (
        <PlaylistRows tracks={state.previous.tracks} dim />
      ) : (
        <>
          <p className="sr-only" aria-live="polite">
            {t.result.loading}
          </p>
          <SkeletonRows n={length} />
        </>
      );
    case "waiting":
      return <SkeletonRows n={length} />;
    case "catalog_loading":
      return (
        <Notice>
          <span className="animate-pulse">{t.result.catalogLoading}</span>
        </Notice>
      );
    case "no_catalog":
      return (
        <Notice>
          <span>{t.result.noCatalog}</span>
          <code className="rounded-lg bg-ink px-3 py-1.5 text-sm text-text">
            {t.result.noCatalogCommand}
          </code>
        </Notice>
      );
    case "catalog_error":
      return <Notice>{t.result.catalogError}</Notice>;
    case "stale":
      return (
        <Notice action={{ label: t.result.reload, onClick: () => location.reload() }}>
          {t.result.stale}
        </Notice>
      );
    case "down":
      return (
        <Notice action={{ label: t.result.retry, onClick: retry }}>{t.result.serverDown}</Notice>
      );
  }
}

/** Result (HANDOFF §4.3): personality card, playlist preview, export, tweak, reshuffle, 10 more. */
export function Result({
  bank,
  session,
  tweaks,
  health,
  refreshHealth,
  dispatch,
}: {
  bank: Bank;
  session: SessionState;
  tweaks: TweakSteps;
  health: HealthState;
  refreshHealth: () => void;
  dispatch: (a: AppAction) => void;
}) {
  const view = useMemo(() => viewSession(bank, session), [bank, session]);
  const taste = useMemo(() => tasteVector(bank, view.profile), [bank, view.profile]);
  const { state, retry } = usePlaylist(bank, session, tweaks, health, refreshHealth);
  const ready = state.kind === "ready" ? state : null;
  const seed = ready?.data.seed ?? null;
  const [votes, setVotes] = useState<Record<string, Vote>>({});
  const vote = seed ? (votes[seed] ?? voteFor(seed)) : null;
  // "+25 deeper cuts" pages and swaps, for the playlist they were made from (keyed by its seed).
  const [edits, setEdits] = useState<{
    seed: string;
    tracks: readonly PlaylistTrackOut[];
    pages: number;
    swaps: number;
  } | null>(null);
  const [pending, setPending] = useState<"more" | number | null>(null);
  const [failed, setFailed] = useState(false);
  const shown = ready ? (edits?.seed === ready.data.seed ? edits.tracks : ready.data.tracks) : [];
  const progress = edits?.seed === seed ? edits : null;
  const follow = async (
    req: PlaylistRequest,
    apply: (got: PlaylistTrackOut[]) => PlaylistTrackOut[],
  ) => {
    if (!ready) return false;
    setFailed(false);
    const r = await postPlaylist(req);
    if (!r.ok || r.data.tracks.length === 0) {
      setFailed(true);
      return false;
    }
    setEdits({
      seed: ready.data.seed,
      tracks: apply([...r.data.tracks]),
      pages: progress?.pages ?? 0,
      swaps: progress?.swaps ?? 0,
    });
    return true;
  };
  const onMore = async () => {
    if (!ready || pending !== null) return;
    setPending("more");
    const page = (progress?.pages ?? 0) + 1;
    const req = moreRequest(
      bank,
      session,
      tweaks,
      ready.request,
      shown.map((x) => x.track_id),
      page,
    );
    if (await follow(req, (got) => [...shown, ...got]))
      setEdits((e) => (e ? { ...e, pages: page } : e));
    setPending(null);
  };
  const onSwap = async (i: number) => {
    if (!ready || pending !== null) return;
    setPending(i);
    const n = (progress?.swaps ?? 0) + 1;
    const req = swapRequest(
      ready.request,
      shown.map((x) => x.track_id),
      n,
    );
    if (
      await follow(req, (got) => shown.map((x, k) => (k === i ? (got[0] as PlaylistTrackOut) : x)))
    )
      setEdits((e) => (e ? { ...e, swaps: n } : e));
    setPending(null);
  };

  // The title names the listener's own (untweaked) personality; tweaks go in the description.
  const title = playlistTitle(bank.dimensions, taste, view.answered, seed ?? "0000");
  const names = tweakNames(tweaks);
  const description = [title.description, names.length ? t.result.tweaked(names) : ""]
    .filter(Boolean)
    .join(" · ");
  const license = health.kind === "ok" ? health.health.catalog?.license : null;

  const onExport = (f: ExportFormat) => {
    if (ready)
      download(
        exportPlaylist(
          f,
          toExport(title.title, description, ready.data, ready.request, tweaks, shown),
        ),
      );
  };
  const onVote = (v: Vote) => {
    if (!ready) return;
    recordVote({
      seed: ready.data.seed,
      catalog_version: ready.data.catalog_version,
      vote: v,
      answered: view.answered,
    });
    setVotes((cur) => ({ ...cur, [ready.data.seed]: v }));
  };
  const busy = state.kind === "loading";

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-4 pb-12 pt-4">
      <header className="flex items-center justify-between">
        <span className="text-lg font-black tracking-tight">
          <span className="text-side-a">A</span>
          <span className="text-side-b">B</span>Tune
        </span>
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-sm font-semibold text-text-3 hover:text-text"
          onClick={() => dispatch({ type: "restart" })}
        >
          {t.result.startOver}
        </button>
      </header>

      {view.status === "exhausted" && (
        <p className="rounded-2xl bg-surface px-4 py-3 text-sm text-text-2">
          {t.result.exhausted(view.answered)}
        </p>
      )}

      <PersonalityCard dims={bank.dimensions} taste={taste} answered={view.answered} />

      <section aria-labelledby="playlist" className="flex flex-col gap-4">
        <header>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-text-3">
            {t.result.playlist}
          </p>
          <h2 id="playlist" className="mt-1 text-2xl font-black leading-tight text-balance">
            {title.title}
          </h2>
          <p className="mt-1 text-sm text-text-3">{seed ? description : " "}</p>
        </header>

        <div className="flex flex-wrap gap-2">
          <ExportMenu onExport={onExport} disabled={!ready} />
          <button
            type="button"
            disabled={busy || state.kind !== "ready"}
            className="flex min-h-12 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-raised px-4 font-bold text-text hover:bg-line disabled:opacity-40"
            onClick={() => dispatch({ type: "session", action: { type: "reshuffle" } })}
          >
            🔀 {t.result.reshuffle}
          </button>
          {view.status === "profile_ready" && (
            <button
              type="button"
              className="flex min-h-12 w-full items-center justify-center gap-1.5 rounded-2xl border-2 border-profile/60 px-4 font-bold text-text hover:bg-profile/10 sm:w-auto sm:flex-1"
              onClick={() => dispatch({ type: "session", action: { type: "ten_more" } })}
            >
              ＋ {t.result.tenMore}
            </button>
          )}
        </div>

        <TweakBar
          steps={tweaks}
          onTweak={(id) => dispatch({ type: "tweak", id })}
          onReset={() => dispatch({ type: "reset_tweaks" })}
        />

        <PlaylistBody
          state={state}
          length={session.config.length}
          retry={retry}
          tracks={shown}
          onSwap={onSwap}
          swapping={typeof pending === "number" ? pending : null}
        />
        {ready && (
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              disabled={pending !== null}
              className="flex min-h-12 w-full items-center justify-center rounded-2xl border-2 border-profile/60 px-4 font-bold text-text hover:bg-profile/10 disabled:opacity-50"
              onClick={onMore}
            >
              {pending === "more" ? t.result.moreLoading : t.result.more(MORE_LENGTH)}
            </button>
            {failed && (
              <p className="text-sm text-text-3" role="status">
                {t.result.actionFailed}
              </p>
            )}
          </div>
        )}
      </section>

      {ready && <Feedback vote={vote} onVote={onVote} />}

      <footer className="text-center text-xs leading-relaxed text-text-3">
        {license && (
          <p>
            {t.result.data}: {license.attribution}{" "}
            <a href={license.url} target="_blank" rel="noopener noreferrer" className="underline">
              {license.id}
            </a>
          </p>
        )}
      </footer>
    </main>
  );
}
