import {
  type Bank,
  type Choice,
  questionText,
  type SessionState,
  viewSession,
} from "@abtune/engine";
import { useEffect, useMemo, useState } from "react";
import { QuizCard } from "../components/QuizCard.tsx";
import { ActionBar, HintChip, ProgressBar } from "../components/QuizChrome.tsx";
import { liveHint } from "../lib/hints.ts";
import type { AppAction } from "../state/app.ts";
import { t } from "../strings.ts";

/** Two-tap "Start over", so a stray tap can't wipe a quiz (no blocking dialogs). */
function RestartButton({ onRestart }: { onRestart: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      className={`rounded-lg px-2 py-1 text-sm font-semibold ${armed ? "text-side-a" : "text-text-3 hover:text-text"}`}
      onClick={() => (armed ? onRestart() : setArmed(true))}
    >
      {armed ? `${t.quiz.quit}?` : t.quiz.quit}
    </button>
  );
}

const KEYS: Readonly<Record<string, Choice | "back">> = {
  ArrowLeft: "a",
  ArrowRight: "b",
  ArrowUp: "both",
  ArrowDown: "skip",
  Backspace: "back",
};

/** The quiz (HANDOFF §4.2): runs entirely in the browser, no network per question. */
export function Quiz({
  bank,
  session,
  dispatch,
}: {
  bank: Bank;
  session: SessionState;
  dispatch: (a: AppAction) => void;
}) {
  const view = useMemo(() => viewSession(bank, session), [bank, session]);
  const hint = useMemo(() => liveHint(bank, session.answer_log), [bank, session.answer_log]);
  const question = view.question;

  const answer = (choice: Choice) => {
    if (question)
      dispatch({ type: "session", action: { type: "answer", choice, id: question.id } });
  };
  const back = () => dispatch({ type: "session", action: { type: "back" } });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      const k = KEYS[e.key];
      if (!k) return;
      e.preventDefault();
      if (k === "back") back();
      else answer(k);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!question) return null;
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
      <header className="flex items-center justify-between">
        <span className="text-lg font-black tracking-tight">
          <span className="text-side-a">A</span>
          <span className="text-side-b">B</span>Tune
        </span>
        <RestartButton onRestart={() => dispatch({ type: "restart" })} />
      </header>
      <ProgressBar position={view.position} answered={view.answered} mode={view.mode} />
      <HintChip hint={hint} />
      {/* One keyed wrapper: a new question remounts heading and card (fresh swipe state, enter animation). */}
      <div key={question.id} className="flex flex-1 flex-col justify-center gap-5">
        <h1
          dir="auto"
          className="animate-fade-in text-center text-2xl font-black leading-tight text-balance"
        >
          {questionText(question)}
        </h1>
        <QuizCard question={question} onPick={answer} />
      </div>
      <ActionBar
        canBack={session.answer_log.length > 0}
        onBack={back}
        onBoth={() => answer("both")}
        onSkip={() => answer("skip")}
      />
      <p className="text-center text-xs text-text-3">
        <span className="[@media(hover:hover)]:hidden">{t.quiz.swipe}</span>
        <span className="hidden [@media(hover:hover)]:inline">{t.quiz.keys}</span>
      </p>
    </main>
  );
}
