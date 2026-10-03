import { type Hint, hintKey } from "@abtune/engine";
import { hintText, t } from "../strings.ts";

/** "12 / 20" plus a bar of answers given (HANDOFF §4.2). Skips don't count. */
export function ProgressBar({
  position,
  answered,
  mode,
}: {
  position: number;
  answered: number;
  mode: number;
}) {
  const pct = Math.min(100, (answered / mode) * 100);
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-2 flex-1 overflow-hidden rounded-full bg-raised"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={mode}
        aria-valuenow={answered}
        aria-label="Answers"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-side-a to-side-b transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="min-w-14 text-end text-sm font-bold tabular-nums text-text-2">
        {t.quiz.progress(Math.min(position, mode), mode)}
      </span>
    </div>
  );
}

/** A live hint ("Era locking in: 80s–90s"); re-animates when the hint changes. */
export function HintChip({ hint }: { hint: Hint | null }) {
  return (
    <div className="flex h-8 items-center justify-center" aria-live="polite">
      {hint && (
        <span
          key={hintKey(hint)}
          className="animate-fade-in rounded-full border border-profile/40 bg-profile/10 px-3 py-1 text-sm font-semibold text-text"
        >
          ✨ {hintText(hint)}
        </span>
      )}
    </div>
  );
}

/** Back / Both! / Skip under the card. */
export function ActionBar({
  canBack,
  onBack,
  onBoth,
  onSkip,
}: {
  canBack: boolean;
  onBack: () => void;
  onBoth: () => void;
  onSkip: () => void;
}) {
  const base =
    "flex min-h-12 flex-1 items-center justify-center gap-1.5 rounded-2xl px-3 text-base font-bold transition-colors disabled:opacity-35";
  return (
    <div className="flex gap-2">
      <button
        type="button"
        className={`${base} bg-raised text-text-2 hover:bg-line`}
        disabled={!canBack}
        onClick={onBack}
      >
        <span aria-hidden="true">↶</span> {t.quiz.back}
      </button>
      <button
        type="button"
        className={`${base} bg-gradient-to-r from-side-a/25 to-side-b/25 text-text hover:from-side-a/40 hover:to-side-b/40`}
        onClick={onBoth}
      >
        {t.quiz.both}
      </button>
      <button
        type="button"
        className={`${base} bg-raised text-text-2 hover:bg-line`}
        onClick={onSkip}
      >
        {t.quiz.skip} <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}
