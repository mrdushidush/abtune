import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PlaylistRequest,
  PlaylistTrackOut,
  SpotifyOutcome,
  SpotifyPushResponse,
  SpotifyStatus,
} from "../../api-types.ts";
import {
  fetchSpotifyStatus,
  loginHref,
  newTokenKey,
  postSpotifyDisconnect,
  postSpotifyPush,
  pushRequest,
} from "../state/spotify.ts";
import { t } from "../strings.ts";
import { Icon } from "./Icon.tsx";

const DASHBOARD = "https://developer.spotify.com/dashboard";

const btn =
  "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-raised px-3 text-sm font-bold text-text hover:bg-line disabled:opacity-40";
const primary =
  "flex min-h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-to-r from-side-a to-side-b px-4 font-extrabold text-ink disabled:opacity-50";

/**
 * Save to Spotify (HANDOFF §11.1, M5): a setup wizard until the server has a Spotify app, then
 * connect, then push. Opens by itself when the sign-in comes back (`outcome`).
 */
export function SpotifyButton({
  tracks,
  request,
  title,
  description,
  shareCode,
  onExportCsv,
  outcome,
  onOutcomeSeen,
}: {
  /** The playlist on screen, in order. */
  tracks: readonly PlaylistTrackOut[];
  /** The first playlist's request (null until it's ready). */
  request: PlaylistRequest | null;
  title: string;
  description: string;
  /** To reopen this playlist at the redirect URI's address. */
  shareCode: string | null;
  onExportCsv: () => void;
  outcome: SpotifyOutcome | null;
  onOutcomeSeen: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const enabled = tracks.length > 0 && request !== null;
  const show = useCallback(() => {
    setOpen(true);
    dialog.current?.showModal();
  }, []);
  // Back from Spotify's sign-in: continue where the listener left off.
  useEffect(() => {
    if (outcome && enabled && !dialog.current?.open) show();
  }, [outcome, enabled, show]);

  return (
    <>
      <button
        type="button"
        disabled={!enabled}
        className="flex min-h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-raised px-4 font-bold text-text hover:bg-line disabled:opacity-40 sm:flex-1"
        onClick={show}
      >
        ♫ {t.spotify.button}
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; keys have Escape and Close */}
      <dialog
        ref={dialog}
        aria-labelledby="spotify-title"
        onClose={() => {
          setOpen(false);
          onOutcomeSeen();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
        className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-3xl border border-line bg-surface p-0 text-text outline-none backdrop:bg-ink/80"
      >
        {open && request && (
          <SpotifyBody
            tracks={tracks}
            request={request}
            title={title}
            description={description}
            shareCode={shareCode}
            onExportCsv={onExportCsv}
            outcome={outcome}
            onClose={() => dialog.current?.close()}
          />
        )}
      </dialog>
    </>
  );
}

type Status =
  | { readonly kind: "loading" }
  | { readonly kind: "down" }
  | { readonly kind: "ok"; readonly status: SpotifyStatus };

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "done"; readonly report: SpotifyPushResponse }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly retryAfter: number | null;
      readonly url: string | null;
    };

function SpotifyBody({
  tracks,
  request,
  title,
  description,
  shareCode,
  onExportCsv,
  outcome,
  onClose,
}: {
  tracks: readonly PlaylistTrackOut[];
  request: PlaylistRequest;
  title: string;
  description: string;
  shareCode: string | null;
  onExportCsv: () => void;
  outcome: SpotifyOutcome | null;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [notice, setNotice] = useState<string | null>(
    outcome && outcome !== "connected" ? t.spotify.outcome[outcome] : null,
  );
  const [name, setName] = useState(title);
  const [isPublic, setPublic] = useState(false);
  // Kept while the sheet is open, so "check again" doesn't change a key already copied.
  const key = useMemo(newTokenKey, []);
  const [checks, setChecks] = useState(0);

  const load = useCallback(() => {
    setStatus({ kind: "loading" });
    fetchSpotifyStatus().then((r) =>
      setStatus(r.ok ? { kind: "ok", status: r.data } : { kind: "down" }),
    );
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setPhase({ kind: "saving" });
    setNotice(null);
    const r = await postSpotifyPush(
      pushRequest(name.trim() || title, description, isPublic, tracks, request),
    );
    if (r.ok) return setPhase({ kind: "done", report: r.data });
    const code =
      r.status === 0
        ? "network"
        : r.error?.error === "version_mismatch"
          ? "stale"
          : (r.error?.error ?? "other");
    if (code === "not_connected" || code === "unauthorized") {
      setPhase({ kind: "idle" });
      setNotice(t.spotify.errors.not_connected);
      return load();
    }
    setPhase({
      kind: "failed",
      code,
      retryAfter: r.error?.retry_after ?? null,
      url: r.error?.playlist_url ?? null,
    });
  };

  const disconnect = async () => {
    await postSpotifyDisconnect();
    setNotice(t.spotify.disconnected);
    load();
  };

  let body: React.ReactNode;
  if (status.kind === "loading") body = <p className="text-text-2">{t.spotify.checking}</p>;
  else if (status.kind === "down")
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-text-2">{t.spotify.serverDown}</p>
        <button type="button" className={btn} onClick={load}>
          {t.spotify.retry}
        </button>
      </div>
    );
  else if (!status.status.configured)
    body = (
      <Setup
        status={status.status}
        tokenKey={key}
        checked={checks > 0}
        onCheck={() => {
          setChecks((n) => n + 1);
          load();
        }}
      />
    );
  else if (location.origin !== status.status.app_origin) {
    const there = `${status.status.app_origin}/${shareCode ? `#s=${shareCode}` : ""}`;
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-text-2">{t.spotify.wrongHost(status.status.app_origin)}</p>
        <a href={there} className={primary}>
          {t.spotify.openThere}
        </a>
      </div>
    );
  } else if (!status.status.connected)
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-text-2">{t.spotify.connectIntro}</p>
        <p className="text-xs text-text-3">{t.spotify.connectScope}</p>
        <a
          href={loginHref(`${location.pathname}${location.search}${location.hash}`)}
          className={primary}
        >
          {t.spotify.connect}
        </a>
      </div>
    );
  else if (phase.kind === "done") body = <Done report={phase.report} />;
  else {
    const who = status.status.connected.display_name || status.status.connected.user_id;
    const saving = phase.kind === "saving";
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-text-2">{t.spotify.connectedAs(who)}</span>
          <button
            type="button"
            disabled={saving}
            className="font-semibold text-text-3 hover:text-text disabled:opacity-40"
            onClick={disconnect}
          >
            {t.spotify.disconnect}
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="spotify-name" className="text-sm font-bold text-text-2">
            {t.spotify.name}
          </label>
          <input
            id="spotify-name"
            value={name}
            maxLength={100}
            disabled={saving}
            onChange={(e) => setName(e.currentTarget.value)}
            className="w-full rounded-xl border border-line bg-ink px-3 py-2 text-text"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-text-2">
          <input
            type="checkbox"
            checked={isPublic}
            disabled={saving}
            onChange={(e) => setPublic(e.currentTarget.checked)}
            className="size-4 accent-profile"
          />
          {t.spotify.public}
        </label>
        {phase.kind === "failed" && <Failure phase={phase} onExportCsv={onExportCsv} />}
        <button type="button" className={primary} disabled={saving} onClick={save}>
          {saving ? t.spotify.saving(tracks.length) : t.spotify.save(tracks.length)}
        </button>
        <p className="text-xs text-text-3">{t.spotify.backfillNote}</p>
        <p className="sr-only" role="status">
          {saving ? t.spotify.saving(tracks.length) : ""}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-5">
      <header className="flex items-center justify-between gap-3">
        <h2 id="spotify-title" className="text-lg font-black">
          {status.kind === "ok" && !status.status.configured
            ? t.spotify.setupTitle
            : phase.kind === "done"
              ? `✓ ${t.spotify.done}`
              : t.spotify.title}
        </h2>
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-sm font-semibold text-text-3 hover:text-text"
          onClick={onClose}
        >
          {t.spotify.close}
        </button>
      </header>
      {notice && (
        <p className="rounded-xl bg-raised px-3 py-2 text-sm text-text-2" role="status">
          {notice}
        </p>
      )}
      {body}
    </div>
  );
}

function Failure({
  phase,
  onExportCsv,
}: {
  phase: Extract<Phase, { kind: "failed" }>;
  onExportCsv: () => void;
}) {
  const e = t.spotify.errors;
  const known = (e as Record<string, unknown>)[phase.code];
  const text =
    phase.url !== null
      ? e.partial
      : phase.code === "rate_limited"
        ? e.rate_limited(phase.retryAfter)
        : typeof known === "string"
          ? known
          : e.other;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-side-a/50 px-3 py-3" role="alert">
      <p className="text-sm text-text">{text}</p>
      {phase.url && (
        <a href={phase.url} target="_blank" rel="noopener noreferrer" className="text-sm underline">
          {phase.url}
        </a>
      )}
      {phase.code === "stale" && (
        <button type="button" className={btn} onClick={() => location.reload()}>
          {t.result.reload}
        </button>
      )}
      {phase.code === "quota_exceeded" && (
        <button type="button" className={btn} onClick={onExportCsv}>
          <Icon name="download" className="size-4" />
          {t.spotify.exportInstead}
        </button>
      )}
    </div>
  );
}

function Done({ report }: { report: SpotifyPushResponse }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-text">{t.spotify.doneCount(report.added, report.name)}</p>
      <p className="text-sm text-text-2">
        {t.spotify.matchLine(report.matched, report.replaced.length)}
      </p>
      {report.missing.length > 0 && (
        <p className="text-sm text-text-3">{t.spotify.missingLine(report.missing.length)}</p>
      )}
      <a href={report.playlist_url} target="_blank" rel="noopener noreferrer" className={primary}>
        {t.spotify.open}
      </a>
      {report.replaced.length > 0 && (
        <details className="text-sm text-text-2">
          <summary className="cursor-pointer font-semibold">{t.spotify.swaps}</summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {report.replaced.map((r) => (
              <li key={r.position} className="flex flex-col">
                <span className="text-text-3 line-through [unicode-bidi:plaintext]">
                  {r.missing.title} — {r.missing.artist}
                </span>
                <span className="[unicode-bidi:plaintext]">
                  → {r.replacement.title} — {r.replacement.artist}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** One-time setup (HANDOFF §11.1 wizard): what to click in Spotify's dashboard and what to paste. */
function Setup({
  status,
  tokenKey,
  checked,
  onCheck,
}: {
  status: SpotifyStatus;
  tokenKey: string;
  /** "Check again" was pressed at least once. */
  checked: boolean;
  onCheck: () => void;
}) {
  const redirectBad = status.missing.includes("SPOTIFY_REDIRECT_URI");
  const redirect = redirectBad
    ? `http://127.0.0.1:${location.port || "8787"}/callback`
    : status.redirect_uri;
  const env = [
    status.missing.includes("SPOTIFY_CLIENT_ID") ? "SPOTIFY_CLIENT_ID=" : "",
    status.missing.includes("TOKEN_ENCRYPTION_KEY") ? `TOKEN_ENCRYPTION_KEY=${tokenKey}` : "",
    redirectBad ? `SPOTIFY_REDIRECT_URI=${redirect}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const steps: React.ReactNode[] = [
    <>
      {t.spotify.stepDashboard}{" "}
      <a href={DASHBOARD} target="_blank" rel="noopener noreferrer" className="underline">
        {t.spotify.dashboard}
      </a>
    </>,
    t.spotify.stepApp,
    <>
      {t.spotify.stepRedirect}
      <CopyBlock text={redirect} />
    </>,
    t.spotify.stepUsers,
    <>
      {t.spotify.stepEnv}
      <CopyBlock text={env} />
      {status.missing.includes("SPOTIFY_CLIENT_ID") && (
        <span className="text-xs text-text-3">{t.spotify.clientIdHint}</span>
      )}
    </>,
    <>
      {t.spotify.stepRestart}
      <CopyBlock text={t.spotify.restartCommand} />
      <span className="text-xs text-text-3">{t.spotify.restartOther}</span>
    </>,
  ];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-2">{t.spotify.setupIntro}</p>
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of steps
          <li key={i} className="flex gap-3 text-sm text-text">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-xs font-black text-text-2">
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">{s}</div>
          </li>
        ))}
      </ol>
      <p className="text-xs text-text-3" role="status">
        {checked ? t.spotify.stillMissing(status.missing.join(", ")) : ""}
      </p>
      <button type="button" className={btn} onClick={onCheck}>
        {t.spotify.checkAgain}
      </button>
    </div>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-lg bg-ink px-3 py-2 font-mono text-xs text-text-2">
        {text}
      </pre>
      <button
        type="button"
        className="shrink-0 rounded-lg bg-raised px-2.5 py-2 text-xs font-bold text-text hover:bg-line"
        onClick={() =>
          navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? `✓ ${t.spotify.copied}` : t.spotify.copy}
      </button>
    </div>
  );
}
