import { type ExportTrack, toSongList } from "@abtune/connectors";
import { useEffect, useRef, useState } from "react";
import { track } from "../state/stats.ts";
import { t } from "../strings.ts";

/**
 * The apps TuneMyMusic's "Free text" pages lead to. Each page opens on a paste box with the app
 * already picked: paste, Convert song list, Transfer to <app>, sign in there.
 */
export const MUSIC_APPS = [
  { id: "spotify", name: "Spotify" },
  { id: "apple_music", name: "Apple Music" },
  { id: "youtube_music", name: "YouTube Music" },
] as const;
export type MusicApp = (typeof MUSIC_APPS)[number]["id"];

export const transferUrl = (app: MusicApp) =>
  `https://www.tunemymusic.com/transfer/freetext-to-${app.replace("_", "-")}`;

const btn =
  "flex min-h-12 items-center justify-center gap-1.5 rounded-xl bg-raised px-3 font-bold text-text hover:bg-line";

/**
 * "Add to your music app": the playlist as plain "Artist - Title" lines on the clipboard, and
 * TuneMyMusic opened for the chosen app. Spotify's development mode allows 5 users per app, so a
 * public instance can't save to Spotify itself; this works for every visitor and every app, and
 * ABTune sends nothing anywhere: the visitor pastes the list.
 */
export function MusicAppButton({
  tracks,
}: {
  /** Null until the playlist is ready. */
  tracks: readonly Pick<ExportTrack, "artist" | "title">[] | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={!tracks?.length}
        className="flex min-h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-to-r from-side-a to-side-b px-4 font-extrabold text-ink disabled:opacity-40 sm:flex-1"
        onClick={() => {
          setOpen(true);
          dialog.current?.showModal();
        }}
      >
        ♫ {t.handoff.button}
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; keys have Escape and Close */}
      <dialog
        ref={dialog}
        aria-labelledby="handoff-title"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // A click on the backdrop lands on the dialog element itself.
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
        className="m-auto w-[min(30rem,calc(100%-2rem))] rounded-3xl border border-line bg-surface p-0 text-text backdrop:bg-ink/80"
      >
        {open && tracks && (
          <HandoffBody
            list={toSongList(tracks)}
            count={tracks.length}
            onClose={() => dialog.current?.close()}
          />
        )}
      </dialog>
    </>
  );
}

function HandoffBody({
  list,
  count,
  onClose,
}: {
  list: string;
  count: number;
  onClose: () => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (copy === "failed") field.current?.select();
  }, [copy]);

  // Called inside the click, so the browser counts it as the user's own copy.
  const copyList = () => {
    try {
      navigator.clipboard.writeText(list).then(
        () => setCopy("done"),
        () => setCopy("failed"),
      );
    } catch {
      // No clipboard API (a plain-HTTP LAN address): show the list to copy by hand.
      setCopy("failed");
    }
  };

  return (
    <div className="flex flex-col gap-4 p-5">
      <header className="flex items-center justify-between gap-3">
        <h2 id="handoff-title" className="text-lg font-black">
          {t.handoff.title}
        </h2>
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-sm font-semibold text-text-3 hover:text-text"
          onClick={onClose}
        >
          {t.handoff.close}
        </button>
      </header>

      <p className="text-sm text-text-2">{t.handoff.intro}</p>
      <ol className="flex flex-col gap-2">
        {t.handoff.steps(count).map((s, i) => (
          <li key={s} className="flex gap-3 text-sm text-text">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-xs font-black text-text-2">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 pt-0.5">{s}</span>
          </li>
        ))}
      </ol>

      <div className="grid gap-2">
        {MUSIC_APPS.map((app) => (
          <a
            key={app.id}
            href={transferUrl(app.id)}
            target="_blank"
            rel="noopener noreferrer"
            className={btn}
            onClick={() => {
              track(`handoff_${app.id}`);
              copyList();
            }}
          >
            {/* U+FE0E: the text arrow, not the emoji some fonts draw */}
            {app.name} <span aria-hidden="true">↗︎</span>
          </a>
        ))}
      </div>

      <div className="flex flex-col gap-2" role="status">
        {copy === "done" && (
          <p className="text-sm font-semibold text-text">{t.handoff.copied(count)}</p>
        )}
        {copy === "failed" && (
          <>
            <p className="text-sm text-text-2">{t.handoff.copyFailed}</p>
            <textarea
              ref={field}
              readOnly
              value={list}
              rows={6}
              aria-label={t.handoff.listLabel}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-xl border border-line bg-ink px-3 py-2 font-mono text-xs text-text-2 [unicode-bidi:plaintext]"
            />
          </>
        )}
      </div>
      {copy === "done" && (
        <button
          type="button"
          className="self-center text-sm font-semibold text-text-3 underline hover:text-text"
          onClick={copyList}
        >
          {t.handoff.copyAgain}
        </button>
      )}

      <p className="text-xs text-text-3">{t.handoff.fine}</p>
    </div>
  );
}
