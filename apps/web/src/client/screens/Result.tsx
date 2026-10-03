import { type ExportFormat, type ExportPlaylist, exportPlaylist } from "@abtune/connectors";
import {
  archetypeName,
  type Bank,
  encodeShare,
  engineVersion,
  playlistTitle,
  type SessionState,
  type ShareOp,
  TWEAK_AXES,
  type TweakSteps,
  traits,
  viewSession,
} from "@abtune/engine";
import { useMemo, useState } from "react";
import type {
  PlaylistRequest,
  PlaylistResponse,
  PlaylistTrackOut,
  SpotifyOutcome,
} from "../../api-types.ts";
import { PersonalityCard } from "../components/PersonalityCard.tsx";
import { PlaylistRows, SkeletonRows } from "../components/PlaylistRows.tsx";
import { ExportMenu, Feedback, TextTweak, TweakBar } from "../components/ResultActions.tsx";
import { ShareButton } from "../components/ShareSheet.tsx";
import { SpotifyButton } from "../components/SpotifySheet.tsx";
import type { CardInput } from "../lib/card-image.ts";
import { download } from "../lib/download.ts";
import { aiView, failureOf, postTextTweak } from "../state/ai.ts";
import { MORE_LENGTH, postPlaylist } from "../state/api.ts";
import type { AiState, AppAction } from "../state/app.ts";
import { recordVote, type Vote, voteFor } from "../state/feedback.ts";
import {
  type HealthState,
  type PlaylistState,
  useAiInterpret,
  usePlaylist,
} from "../state/hooks.ts";
import { applyEdit, editRequest } from "../state/share.ts";
import { offerSpotify } from "../state/spotify.ts";
import { t, tweakSummary } from "../strings.ts";

const NO_OPS: readonly ShareOp[] = [];

export function tweakNames(steps: TweakSteps): string[] {
  return TWEAK_AXES.filter((a) => (steps[a] ?? 0) !== 0).map((a) => tweakSummary(a, steps[a] ?? 0));
}

export function toExport(
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

export function Notice({
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

export function PlaylistBody({
  state,
  length,
  retry,
  tracks,
  onSwap,
  swapping,
  notes,
}: {
  state: PlaylistState;
  length: number;
  retry: () => void;
  /** What's on screen when ready: the playlist plus appended pages and swaps. */
  tracks: readonly PlaylistTrackOut[];
  onSwap?: (i: number) => void;
  swapping?: number | null;
  /** AI rerank's "why" per track id. */
  notes?: Readonly<Record<string, string>>;
}) {
  switch (state.kind) {
    case "ready":
      return (
        <>
          {state.data.warnings.includes("catalog_exhausted") && (
            <p className="text-sm text-text-3">{t.result.shortPlaylist}</p>
          )}
          <PlaylistRows tracks={tracks} onSwap={onSwap} swapping={swapping} notes={notes} />
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

/**
 * Result (HANDOFF §4.3): personality card, playlist preview, export, tweak, reshuffle, 10 more. With
 * AI on (§10), T1 reads the answers first (the playlist waits, or the listener skips it), T3 adds a
 * free-text tweak, and T2 may pick the songs, each falling back to the classic engine with a notice.
 */
export function Result({
  bank,
  session,
  tweaks,
  ai,
  health,
  refreshHealth,
  dispatch,
  spotifyOutcome,
  onSpotifySeen,
}: {
  bank: Bank;
  session: SessionState;
  tweaks: TweakSteps;
  /** The session's AI state (null: AI off). */
  ai: AiState | null;
  health: HealthState;
  refreshHealth: () => void;
  dispatch: (a: AppAction) => void;
  /** Back from Spotify's sign-in: reopen the Spotify sheet. */
  spotifyOutcome: SpotifyOutcome | null;
  onSpotifySeen: () => void;
}) {
  const view = useMemo(() => viewSession(bank, session), [bank, session]);
  const serverAi = health.kind === "ok" ? health.health.ai : null;
  const aiv = useMemo(
    () => aiView(bank, session, ai, serverAi?.enabled ?? false),
    [bank, session, ai, serverAi?.enabled],
  );
  useAiInterpret(bank, session, ai, aiv, dispatch);
  // The card taste: the engine's profile, with T1's adjustment when the AI made one.
  const taste = aiv.card;
  const rerank = aiv.on && serverAi?.rerank === true;
  const context = useMemo(
    () => ({
      ...(aiv.title ? { title: aiv.title } : {}),
      ...(aiv.blurb ? { blurb: aiv.blurb } : {}),
    }),
    [aiv.title, aiv.blurb],
  );
  const { state, retry } = usePlaylist(bank, session, tweaks, health, refreshHealth, {
    hold: aiv.pending,
    base: aiv.base,
    rerank,
    context,
  });
  const [textBusy, setTextBusy] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const onText = async (text: string) => {
    setTextBusy(true);
    setTextError(null);
    const r = await postTextTweak({ engine_version: engineVersion(bank), text, taste });
    setTextBusy(false);
    if (r.ok)
      dispatch({
        type: "ai_text",
        text: { text, adjust: r.data.adjust, title: r.data.title, blurb: r.data.blurb },
      });
    else setTextError(t.ai.textFailed[failureOf(r.error)] ?? null);
  };
  const ready = state.kind === "ready" ? state : null;
  const seed = ready?.data.seed ?? null;
  const [votes, setVotes] = useState<Record<string, Vote>>({});
  const vote = seed ? (votes[seed] ?? voteFor(seed)) : null;
  // "+25 deeper cuts" pages and swaps, for the playlist they were made from (that response: a
  // tweak keeps the seed, so the seed alone can't tell the playlists apart). A share link replays them.
  const [edits, setEdits] = useState<{
    base: PlaylistResponse;
    tracks: readonly PlaylistTrackOut[];
    ops: readonly ShareOp[];
  } | null>(null);
  const [pending, setPending] = useState<"more" | number | null>(null);
  const [failed, setFailed] = useState(false);
  const current = ready && edits?.base === ready.data ? edits : null;
  const shown = ready ? (current?.tracks ?? ready.data.tracks) : [];
  const ops = current?.ops ?? NO_OPS;
  const edit = async (op: ShareOp) => {
    if (!ready || pending !== null) return;
    setPending(op.op === "more" ? "more" : op.index);
    setFailed(false);
    const req = editRequest(bank.dimensions, aiv.base, tweaks, ready.request, shown, ops, op);
    const r = await postPlaylist(req);
    if (!r.ok || r.data.tracks.length === 0) setFailed(true);
    else
      setEdits({
        base: ready.data,
        tracks: applyEdit(shown, op, r.data.tracks),
        ops: [...ops, op],
      });
    setPending(null);
  };
  const onMore = () => edit({ op: "more" });
  const onSwap = (i: number) => edit({ op: "swap", index: i });

  // The title names the listener's own (untweaked) personality; tweaks go in the description. The
  // AI's title, when it made one, replaces it.
  const engineTitle = playlistTitle(bank.dimensions, taste, view.answered, seed ?? "0000");
  const title = { ...engineTitle, title: aiv.title ?? engineTitle.title };
  const names = tweakNames(tweaks);
  const meta = [title.description, names.length ? t.result.tweaked(names) : ""]
    .filter(Boolean)
    .join(" · ");
  const description = [aiv.blurb ?? "", meta].filter(Boolean).join(" · ");
  const license = health.kind === "ok" ? health.health.catalog?.license : null;
  const name = archetypeName(traits(bank.dimensions, taste));
  const shareCode = useMemo(
    () =>
      ready
        ? encodeShare(bank.dimensions, {
            taste,
            tweaks,
            seed: ready.data.seed,
            length: ready.data.length,
            answered: view.answered,
            engineVersion: ready.data.engine_version,
            catalogVersion: ready.data.catalog_version,
            ops,
            ...(aiv.textAdjust ? { adjust: aiv.textAdjust } : {}),
            ...(ready.data.picks ? { picks: ready.data.picks } : {}),
            ...(aiv.shareTitle ? { title: aiv.shareTitle } : {}),
            ...(aiv.shareBlurb ? { blurb: aiv.shareBlurb } : {}),
          })
        : null,
    [bank, taste, tweaks, ready, view.answered, ops, aiv],
  );
  const card = useMemo<CardInput | null>(
    () =>
      ready
        ? {
            dims: bank.dimensions,
            taste,
            answered: view.answered,
            title: title.title,
            tracks: shown.slice(0, 3),
          }
        : null,
    [bank, taste, view.answered, title.title, ready, shown],
  );

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
  const interpretFailure = aiv.interpret?.status === "failed" ? aiv.interpret.reason : null;
  const rerankFailed =
    ready?.data.rerank !== undefined && ready.data.rerank !== "done" && ready.data.rerank !== "off";

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
          {aiv.blurb && <p className="mt-1 text-text-2">{aiv.blurb}</p>}
          <p className="mt-1 text-sm text-text-3">
            {seed ? meta : " "}
            {aiv.interpret?.status === "done" && (
              <span className="ms-2 rounded-full bg-profile/15 px-2 py-0.5 text-xs font-bold text-profile">
                {t.ai.madeBy}
              </span>
            )}
          </p>
        </header>

        {aiv.pending && (
          <Notice
            action={{
              label: t.ai.skip,
              onClick: () =>
                dispatch({ type: "ai_interpret", key: aiv.key, result: { status: "skipped" } }),
            }}
          >
            <span className="animate-pulse">{t.ai.reading}</span>
          </Notice>
        )}
        {interpretFailure && (
          <p
            className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface px-4 py-3 text-sm text-text-2"
            role="status"
          >
            <span className="flex-1">{t.ai.failed[interpretFailure]}</span>
            {interpretFailure !== "off" && (
              <button
                type="button"
                className="rounded-lg bg-raised px-3 py-1 font-semibold text-text hover:bg-line"
                onClick={() => dispatch({ type: "ai_retry" })}
              >
                {t.ai.retry}
              </button>
            )}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {offerSpotify(health, location.hostname) && (
            <SpotifyButton
              tracks={pending === null ? shown : []}
              request={ready?.request ?? null}
              title={title.title}
              description={description}
              shareCode={shareCode}
              onExportCsv={() => onExport("csv")}
              outcome={spotifyOutcome}
              onOutcomeSeen={onSpotifySeen}
            />
          )}
          <ExportMenu onExport={onExport} disabled={!ready} />
          <ShareButton code={shareCode} card={card} name={name} />
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
        {aiv.on && (
          <TextTweak
            active={ai?.text?.text ?? null}
            busy={textBusy}
            error={textError}
            onSubmit={onText}
            onClear={() => {
              setTextError(null);
              dispatch({ type: "ai_text", text: null });
            }}
          />
        )}
        {busy && rerank && !aiv.pending && (
          <p className="animate-pulse text-sm text-text-3" role="status">
            {t.ai.picking}
          </p>
        )}
        {rerankFailed && (
          <p className="text-sm text-text-3" role="status">
            {t.ai.rerankFailed}
          </p>
        )}

        <PlaylistBody
          state={state}
          length={session.config.length}
          retry={retry}
          tracks={shown}
          onSwap={onSwap}
          swapping={typeof pending === "number" ? pending : null}
          notes={ready?.data.notes}
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
