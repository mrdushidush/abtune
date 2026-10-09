import { EXPORT_FORMATS, type ExportFormat } from "@abtune/connectors";
import {
  MAX_TWEAK_STEPS,
  scalarLabel,
  TWEAK_AXES,
  type TweakId,
  type TweakSteps,
} from "@abtune/engine";
import { useEffect, useRef, useState } from "react";
import { MAX_AI_TEXT } from "../../api-types.ts";
import type { Vote } from "../state/feedback.ts";
import { EXPORT_LABELS, TWEAK_LABELS, TWEAK_PAIRS, t } from "../strings.ts";
import { Icon, TILE } from "./Icon.tsx";

const AXIS_NAMES = {
  energy: scalarLabel("energy").name,
  mood: scalarLabel("valence").name,
  popularity: scalarLabel("mainstream").name,
  era: t.result.era,
} as const;

/** Tweak presets (HANDOFF §4.3, "more energy"): one row per axis, up to ±2 steps each. */
export function TweakBar({
  steps,
  onTweak,
  onReset,
}: {
  steps: TweakSteps;
  onTweak: (id: TweakId) => void;
  onReset: () => void;
}) {
  const any = Object.keys(steps).length > 0;
  const btn =
    "min-h-10 flex-1 rounded-xl bg-raised px-2 text-sm font-semibold text-text-2 transition-colors hover:bg-line hover:text-text disabled:opacity-35";
  return (
    <section aria-label={t.result.tweak} className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-text-2">{t.result.tweak}</h2>
        {any && (
          <button
            type="button"
            className="text-sm font-semibold text-text-3 hover:text-text"
            onClick={onReset}
          >
            {t.result.resetTweaks}
          </button>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {TWEAK_AXES.map((axis) => {
          const n = steps[axis] ?? 0;
          const [down, up] = TWEAK_PAIRS[axis];
          return (
            <div key={axis} className="flex items-center gap-2">
              <button
                type="button"
                className={btn}
                disabled={n <= -MAX_TWEAK_STEPS}
                onClick={() => onTweak(down)}
              >
                {TWEAK_LABELS[down]}
              </button>
              <span
                className={`w-16 shrink-0 text-center text-xs font-bold ${n === 0 ? "text-text-3" : "text-profile"}`}
                aria-live="polite"
              >
                {AXIS_NAMES[axis]}
                <span className="block tabular-nums">
                  {n === 0 ? "·" : n > 0 ? `+${n}` : `−${-n}`}
                </span>
              </span>
              <button
                type="button"
                className={btn}
                disabled={n >= MAX_TWEAK_STEPS}
                onClick={() => onTweak(up)}
              >
                {TWEAK_LABELS[up]}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The free-text tweak (HANDOFF §4.3, T3), when AI is on: "rainy Sunday", "for a 5k run". One is in
 * effect at a time; it stacks with the preset tweaks above.
 */
export function TextTweak({
  active,
  busy,
  error,
  onSubmit,
  onClear,
}: {
  /** The request in effect. */
  active: string | null;
  busy: boolean;
  error: string | null;
  onSubmit: (text: string) => void;
  onClear: () => void;
}) {
  const [text, setText] = useState("");
  const value = text.trim();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value && !busy) onSubmit(value);
      }}
    >
      <label htmlFor="ai-text" className="text-sm font-bold text-text-2">
        {t.ai.textLabel}
      </label>
      <div className="flex gap-2">
        <input
          id="ai-text"
          value={text}
          maxLength={MAX_AI_TEXT}
          placeholder={t.ai.textPlaceholder}
          autoComplete="off"
          className="min-h-11 min-w-0 flex-1 rounded-xl border-2 border-line bg-surface px-3 text-text placeholder:text-text-3 focus:border-profile focus:outline-none"
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy || !value}
          className="min-h-11 shrink-0 rounded-xl bg-raised px-4 font-bold text-text hover:bg-line disabled:opacity-40"
        >
          {busy ? t.ai.textBusy : t.ai.textGo}
        </button>
      </div>
      {active && (
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate rounded-full bg-profile/15 px-3 py-1 text-sm font-semibold text-text [unicode-bidi:plaintext]">
            {t.ai.textActive(active)}
          </span>
          <button
            type="button"
            aria-label={t.ai.textClear}
            title={t.ai.textClear}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-text-3 hover:bg-raised hover:text-text"
            onClick={onClear}
          >
            ✕
          </button>
        </div>
      )}
      {error && (
        <p role="status" className="text-sm text-text-3">
          {error}
        </p>
      )}
    </form>
  );
}

/** Export, a menu of the four §11.2 formats. */
export function ExportMenu({
  onExport,
  disabled,
}: {
  onExport: (f: ExportFormat) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    // On a phone the menu hangs from the whole row (the parent is `relative`), not this narrow tile.
    <div ref={ref} className="sm:relative">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="true"
        className={TILE}
        onClick={() => setOpen((x) => !x)}
      >
        <Icon name="download" />
        <span className="flex items-center gap-0.5">
          {t.result.export}
          <Icon name="chevron" className="size-4" />
        </span>
      </button>
      {open && (
        <ul className="absolute inset-x-0 top-full z-20 mt-2 overflow-hidden rounded-2xl border border-line bg-raised shadow-2xl sm:min-w-72">
          {EXPORT_FORMATS.map((f) => (
            <li key={f}>
              <button
                type="button"
                className="flex w-full flex-col items-start px-4 py-3 text-start hover:bg-line focus-visible:bg-line"
                onClick={() => {
                  setOpen(false);
                  onExport(f);
                }}
              >
                <span className="font-bold text-text">{EXPORT_LABELS[f].name}</span>
                <span className="text-xs text-text-3">{EXPORT_LABELS[f].about}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Is this playlist you?" 👍/👎, kept on this device. */
export function Feedback({ vote, onVote }: { vote: Vote | null; onVote: (v: Vote) => void }) {
  const btn = (v: Vote, emoji: string, label: string) => (
    <button
      type="button"
      aria-pressed={vote === v}
      aria-label={label}
      className={`flex size-12 items-center justify-center rounded-2xl text-2xl transition-colors ${
        vote === v ? "bg-profile/30 ring-2 ring-profile" : "bg-raised hover:bg-line"
      }`}
      onClick={() => onVote(v)}
    >
      {emoji}
    </button>
  );
  return (
    <section className="flex flex-col items-center gap-2 rounded-2xl bg-surface px-4 py-4">
      <p className="font-bold">{t.result.feedbackAsk}</p>
      <div className="flex gap-3">
        {btn("up", "👍", "Yes")}
        {btn("down", "👎", "No")}
      </div>
      <p className={`text-xs text-text-3 ${vote ? "" : "invisible"}`} aria-live="polite">
        {t.result.feedbackThanks}
      </p>
    </section>
  );
}
