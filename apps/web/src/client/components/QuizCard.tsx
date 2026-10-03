import type { Question, Side } from "@abtune/engine";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { dragProgress, isDrag, type SwipeSide, swipeDecision } from "../lib/swipe.ts";
import { t } from "../strings.ts";

interface Drag {
  readonly id: number;
  readonly x0: number;
  readonly y0: number;
  readonly t0: number;
  dragging: boolean;
}

const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Length of the fly-out before the answer lands (skipped with reduced motion). */
const LEAVE_MS = 170;

/**
 * One question: two big options, A (left, pink) and B (right, cyan). Tap an option, or drag the
 * card toward it (HANDOFF §4.2). Keyboard handling lives in the quiz screen.
 */
export function QuizCard({
  question,
  onPick,
}: {
  question: Question;
  onPick: (side: Side) => void;
}) {
  const ref = useRef<HTMLFieldSetElement>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClickUntil = useRef(0);
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState<SwipeSide | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const width = () => ref.current?.offsetWidth ?? 320;
  const progress = leaving ? (leaving === "a" ? -1 : 1) : dragProgress(dx, width());

  const commit = (side: SwipeSide) => {
    if (prefersReducedMotion()) return onPick(side);
    setLeaving(side);
    timer.current = setTimeout(() => onPick(side), LEAVE_MS);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (leaving || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag.current = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      t0: e.timeStamp,
      dragging: false,
    };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const mx = e.clientX - d.x0;
    const my = e.clientY - d.y0;
    if (!d.dragging) {
      if (!isDrag(mx, my)) {
        if (Math.abs(my) > 2 * Math.abs(mx) && Math.abs(my) > 10) drag.current = null; // scrolling
        return;
      }
      d.dragging = true;
      ref.current?.setPointerCapture(e.pointerId);
    }
    setDx(mx);
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.dragging) return;
    suppressClickUntil.current = performance.now() + 400;
    const side = swipeDecision(e.clientX - d.x0, e.timeStamp - d.t0, width());
    if (side) commit(side);
    else setDx(0);
  };
  const onPointerCancel = () => {
    drag.current = null;
    setDx(0);
  };

  const offset = leaving ? (leaving === "a" ? "-140%" : "140%") : `${dx}px`;
  const tilt = leaving ? (leaving === "a" ? -12 : 12) : dx * 0.04;
  const settling = dx === 0 || leaving !== null;

  return (
    <div className="animate-card-in">
      <fieldset
        ref={ref}
        aria-label={question.q ?? `${question.a.label} ${t.quiz.or} ${question.b.label}?`}
        className="grid min-w-0 touch-pan-y select-none grid-cols-2 gap-3"
        style={{
          transform: `translateX(${offset}) rotate(${tilt}deg)`,
          transition: settling ? `transform ${LEAVE_MS}ms ease-out, opacity ${LEAVE_MS}ms` : "none",
          opacity: leaving ? 0 : 1,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClickCapture={(e) => {
          if (performance.now() < suppressClickUntil.current) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        {(["a", "b"] as const).map((side) => {
          const lean = side === "a" ? Math.max(0, -progress) : Math.max(0, progress);
          const color = side === "a" ? "var(--color-side-a)" : "var(--color-side-b)";
          return (
            <button
              key={side}
              type="button"
              disabled={leaving !== null}
              onClick={() => onPick(side)}
              className="flex aspect-[3/4] min-h-44 flex-col items-center justify-center gap-3 rounded-3xl border-2 p-3 text-center outline-offset-4 transition-[background-color,border-color,transform] duration-150 active:scale-[0.97]"
              style={{
                borderColor: `color-mix(in oklab, ${color} ${55 + 45 * lean}%, transparent)`,
                backgroundColor: `color-mix(in oklab, ${color} ${10 + 22 * lean}%, transparent)`,
              }}
            >
              <span className="text-6xl leading-none sm:text-7xl" aria-hidden="true">
                {question[side].emoji}
              </span>
              <span dir="auto" className="text-lg font-extrabold leading-tight sm:text-xl">
                {question[side].label}
              </span>
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}
