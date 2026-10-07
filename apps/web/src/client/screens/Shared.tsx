import { type ExportFormat, exportPlaylist } from "@abtune/connectors";
import {
  archetypeName,
  type Bank,
  decodeShare,
  engineVersion,
  playlistTitle,
  type ShareData,
  traits,
} from "@abtune/engine";
import { useEffect, useMemo, useState } from "react";
import type { PlaylistTrackOut, SpotifyOutcome } from "../../api-types.ts";
import { MusicAppButton } from "../components/MusicAppSheet.tsx";
import { PersonalityCard } from "../components/PersonalityCard.tsx";
import { ExportMenu } from "../components/ResultActions.tsx";
import { ShareButton } from "../components/ShareSheet.tsx";
import { SourceLink } from "../components/SourceLink.tsx";
import { SpotifyButton } from "../components/SpotifySheet.tsx";
import type { CardInput } from "../lib/card-image.ts";
import { download } from "../lib/download.ts";
import { postPlaylist } from "../state/api.ts";
import type { HealthState, PlaylistState } from "../state/hooks.ts";
import { replayShare, shareBase } from "../state/share.ts";
import { offerSpotify } from "../state/spotify.ts";
import { track, trackOnce } from "../state/stats.ts";
import { t } from "../strings.ts";
import { Notice, PlaylistBody, toExport, tweakNames } from "./Result.tsx";

const POLL_MS = 2000;

/**
 * Someone opened a share link (HANDOFF §4.4, M6): their card and the exact playlist, rebuilt from
 * the link alone. Nothing here touches the visitor's own saved session.
 */
export function Shared({
  bank,
  code,
  health,
  refreshHealth,
  hasOwn,
  onLeave,
  spotifyOutcome,
  onSpotifySeen,
}: {
  bank: Bank;
  code: string;
  health: HealthState;
  refreshHealth: () => void;
  /** The visitor has their own quiz in progress or finished. */
  hasOwn: boolean;
  onLeave: () => void;
  /** Back from Spotify's sign-in: reopen the Spotify sheet. */
  spotifyOutcome: SpotifyOutcome | null;
  onSpotifySeen: () => void;
}) {
  const data = useMemo<ShareData | null>(() => {
    try {
      return decodeShare(bank.dimensions, code);
    } catch {
      return null;
    }
  }, [bank, code]);
  const [state, setState] = useState<PlaylistState>({ kind: "waiting" });
  const [tracks, setTracks] = useState<readonly PlaylistTrackOut[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [attempt, setAttempt] = useState(0);

  const h = health.kind === "ok" ? health.health : null;
  const catalog = h?.catalog ?? null;
  const stale = h !== null && h.engine_version !== engineVersion(bank);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` retries
  useEffect(() => {
    if (!data) return;
    if (health.kind === "loading") return setState({ kind: "waiting" });
    if (health.kind === "down" || !h) return setState({ kind: "down" });
    if (stale) return setState({ kind: "stale" });
    if (!catalog) return setState({ kind: "no_catalog" });
    if (catalog.status === "error") return setState({ kind: "catalog_error" });
    if (catalog.status === "loading") {
      setState({ kind: "catalog_loading" });
      const id = setTimeout(refreshHealth, POLL_MS);
      return () => clearTimeout(id);
    }
    let alive = true;
    setState({ kind: "loading", previous: null });
    replayShare(
      bank.dimensions,
      data,
      { engine_version: h.engine_version, catalog_version: catalog.version },
      postPlaylist,
    ).then((r) => {
      if (!alive) return;
      if (r.ok) {
        trackOnce("shared_open", code);
        setTracks(r.tracks);
        setSkipped(r.skipped);
        return setState({ kind: "ready", data: r.response, request: r.first });
      }
      const err = r.result.ok ? null : r.result;
      if (err?.status === 409 || err?.error?.error === "catalog_loading") return refreshHealth();
      if (err?.error?.error === "catalog_error") return setState({ kind: "catalog_error" });
      setState({ kind: "down" });
    });
    return () => {
      alive = false;
    };
  }, [bank, code, data, health, stale, catalog?.status, catalog?.version, attempt]);

  const leave = (
    <button
      type="button"
      className="rounded-lg px-2 py-1 text-sm font-semibold text-text-3 hover:text-text"
      onClick={onLeave}
    >
      {hasOwn ? t.share.yourOwn : t.share.takeQuiz}
    </button>
  );
  const header = (
    <header className="flex items-center justify-between">
      <span className="text-lg font-black tracking-tight">
        <span className="text-side-a">A</span>
        <span className="text-side-b">B</span>Tune
      </span>
      {leave}
    </header>
  );

  if (!data)
    return (
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-4 pb-12 pt-4">
        {header}
        <Notice action={{ label: t.share.takeQuiz, onClick: onLeave }}>{t.share.broken}</Notice>
      </main>
    );

  const ready = state.kind === "ready" ? state : null;
  const engineTitle = playlistTitle(bank.dimensions, data.taste, data.answered, data.seed);
  const title = { ...engineTitle, title: data.title ?? engineTitle.title };
  const names = tweakNames(data.tweaks);
  const meta = [title.description, names.length ? t.result.tweaked(names) : ""]
    .filter(Boolean)
    .join(" · ");
  const description = [data.blurb ?? "", meta].filter(Boolean).join(" · ");
  const name = archetypeName(traits(bank.dimensions, data.taste));
  const other =
    catalog?.status === "ready" &&
    (data.engineVersion !== engineVersion(bank) || data.catalogVersion !== catalog.version);
  const card: CardInput | null = ready
    ? {
        dims: bank.dimensions,
        taste: data.taste,
        answered: data.answered,
        title: title.title,
        tracks: tracks.slice(0, 3),
      }
    : null;
  const onExport = (f: ExportFormat) => {
    if (ready) track(`export_${f}`);
    if (ready)
      download(
        exportPlaylist(
          f,
          toExport(title.title, description, ready.data, ready.request, data.tweaks, tracks),
        ),
      );
  };
  const license = h?.catalog?.license ?? null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-4 pb-12 pt-4">
      {header}

      <PersonalityCard
        dims={bank.dimensions}
        taste={data.taste}
        answered={data.answered}
        kicker={t.share.sharedKicker}
      />

      <section aria-labelledby="playlist" className="flex flex-col gap-4">
        <header>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-text-3">
            {t.share.playlist}
          </p>
          <h2 id="playlist" className="mt-1 text-2xl font-black leading-tight text-balance">
            {title.title}
          </h2>
          {data.blurb && <p className="mt-1 text-text-2">{data.blurb}</p>}
          <p className="mt-1 text-sm text-text-3">{meta || " "}</p>
        </header>

        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <MusicAppButton tracks={ready ? tracks : null} />
            {offerSpotify(health, location.hostname) && (
              <SpotifyButton
                tracks={ready ? tracks : []}
                request={ready?.request ?? null}
                title={title.title}
                description={description}
                shareCode={code}
                onExportCsv={() => onExport("csv")}
                outcome={spotifyOutcome}
                onOutcomeSeen={onSpotifySeen}
              />
            )}
          </div>
          <div className="relative grid grid-cols-2 gap-2">
            <ExportMenu onExport={onExport} disabled={!ready} />
            <ShareButton
              code={ready ? code : null}
              card={card}
              name={name}
              baseUrl={shareBase(health)}
            />
          </div>
        </div>

        {other && (
          <p className="rounded-2xl bg-surface px-4 py-3 text-sm text-text-2">
            {t.share.otherVersion}
          </p>
        )}
        {ready && skipped > 0 && <p className="text-sm text-text-3">{t.share.shortened}</p>}

        <PlaylistBody
          state={state}
          length={data.length}
          retry={() => {
            refreshHealth();
            setAttempt((n) => n + 1);
          }}
          tracks={tracks}
        />
      </section>

      <button
        type="button"
        className="flex min-h-14 w-full items-center justify-center rounded-2xl bg-gradient-to-r from-side-a to-side-b px-4 text-lg font-extrabold text-ink"
        onClick={onLeave}
      >
        {hasOwn ? t.share.yourOwn : t.share.takeQuiz}
      </button>

      <footer className="text-center text-xs leading-relaxed text-text-3">
        {license && (
          <p>
            {t.result.data}: {license.attribution}{" "}
            <a href={license.url} target="_blank" rel="noopener noreferrer" className="underline">
              {license.id}
            </a>
          </p>
        )}
        <p>
          <SourceLink />
        </p>
      </footer>
    </main>
  );
}
