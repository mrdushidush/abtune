import { decadeLabel } from "@abtune/engine";
import { useState } from "react";
import type { PlaylistTrackOut } from "../../api-types.ts";
import { genreEmoji, genreName, t } from "../strings.ts";

/** Search, not an API: the listener's own YouTube or Spotify finds and plays the song. */
const searchUrl = (site: "youtube" | "spotify", tr: PlaylistTrackOut) => {
  const q = encodeURIComponent(`${tr.artist} ${tr.title}`);
  return site === "youtube"
    ? `https://www.youtube.com/results?search_query=${q}`
    : `https://open.spotify.com/search/${q}`;
};

const action =
  "flex min-h-9 items-center gap-1.5 rounded-lg bg-raised px-3 text-sm font-semibold text-text-2 hover:bg-line hover:text-text disabled:opacity-40";

/**
 * Playlist preview rows: genre tile, title / artist, year. Track text uses `unicode-bidi: plaintext`:
 * a Hebrew title reads right-to-left. Alignment is set from the UI's direction, because `start`
 * would follow each title's own direction under plaintext. The ⋯ button opens a row's actions:
 * play it on YouTube or Spotify (search links), swap it, or open it on MusicBrainz. With AI rerank
 * on, a row can carry the model's "why" (HANDOFF §4.3).
 */
export function PlaylistRows({
  tracks,
  dim,
  onSwap,
  swapping,
  notes,
}: {
  tracks: readonly PlaylistTrackOut[];
  dim?: boolean;
  /** "Why" per track id (AI rerank). */
  notes?: Readonly<Record<string, string>>;
  /** Swap row `i` for another song; omit to hide the button. */
  onSwap?: (i: number) => void;
  /** Row being swapped right now. */
  swapping?: number | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ol
      className={`flex flex-col divide-y divide-line/60 transition-opacity ${dim ? "opacity-45" : ""}`}
      aria-busy={dim}
    >
      {tracks.map((tr, i) => {
        const expanded = open === tr.track_id;
        return (
          <li key={tr.track_id} className={`py-2.5 ${swapping === i ? "animate-pulse" : ""}`}>
            <div className="flex items-center gap-3">
              <span className="w-6 shrink-0 text-end text-xs tabular-nums text-text-3">
                {i + 1}
              </span>
              <span
                className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-raised text-xl"
                title={genreName(tr.genre)}
                aria-hidden="true"
              >
                {genreEmoji(tr.genre)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-text text-left [unicode-bidi:plaintext] rtl:text-right">
                  {tr.title}
                </span>
                <span className="block truncate text-sm text-text-2 text-left [unicode-bidi:plaintext] rtl:text-right">
                  {tr.artist}
                </span>
                {notes?.[tr.track_id] && (
                  <span className="mt-0.5 block text-xs leading-snug text-profile">
                    <span className="sr-only">{t.ai.why}: </span>
                    <span aria-hidden="true">💡 </span>
                    {notes[tr.track_id]}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-end text-xs text-text-3">
                {tr.year ?? (tr.decade ? decadeLabel(tr.decade) : "")}
                {tr.genre && <span className="block max-w-24 truncate">{genreName(tr.genre)}</span>}
              </span>
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={t.result.songActions(tr.title)}
                className="flex size-9 shrink-0 items-center justify-center rounded-lg text-lg text-text-3 hover:bg-raised hover:text-text"
                onClick={() => setOpen(expanded ? null : tr.track_id)}
              >
                ⋯
              </button>
            </div>
            {expanded && (
              <div className="mt-2 flex flex-wrap gap-2 ps-[4.75rem]">
                <a
                  className={action}
                  href={searchUrl("youtube", tr)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ▶ {t.result.youtube}
                </a>
                <a
                  className={action}
                  href={searchUrl("spotify", tr)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ♫ {t.result.spotify}
                </a>
                {onSwap && (
                  <button
                    type="button"
                    className={action}
                    disabled={swapping != null}
                    aria-label={t.result.swapLabel(tr.title)}
                    onClick={() => {
                      setOpen(null);
                      onSwap(i);
                    }}
                  >
                    ↻ {t.result.swap}
                  </button>
                )}
                <a
                  className={action}
                  href={`https://musicbrainz.org/recording/${tr.track_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t.result.openOnMusicBrainz}
                >
                  {t.result.musicBrainz}
                </a>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function SkeletonRows({ n }: { n: number }) {
  return (
    <ol className="flex flex-col divide-y divide-line/60" aria-hidden="true">
      {Array.from({ length: Math.min(n, 8) }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <li key={i} className="flex items-center gap-3 py-2.5">
          <span className="w-6" />
          <span className="size-10 animate-pulse rounded-xl bg-raised" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="h-3.5 w-2/3 animate-pulse rounded bg-raised" />
            <span className="h-3 w-1/3 animate-pulse rounded bg-raised" />
          </span>
        </li>
      ))}
    </ol>
  );
}
