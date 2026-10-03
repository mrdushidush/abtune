// Swipe gesture math for the quiz card (pure, so it's unit-tested without a DOM).

/** Movement before a press becomes a drag (below it, it's a tap on an option). */
export const DRAG_START_PX = 10;
/** A drag past this share of the card's width picks that side. */
export const COMMIT_SHARE = 0.25;
/** …or a flick: at least this far, at least this fast. */
export const FLICK_MIN_PX = 40;
export const FLICK_PX_PER_MS = 0.6;

export type SwipeSide = "a" | "b";

/** Left picks A (the left option), right picks B. Null: snap back. */
export function swipeDecision(dx: number, ms: number, width: number): SwipeSide | null {
  const far = Math.abs(dx) >= COMMIT_SHARE * width;
  const flick = Math.abs(dx) >= FLICK_MIN_PX && Math.abs(dx) / Math.max(ms, 1) >= FLICK_PX_PER_MS;
  if (!far && !flick) return null;
  return dx < 0 ? "a" : "b";
}

/** Did the pointer move enough horizontally (and more than vertically) to start a drag? */
export function isDrag(dx: number, dy: number): boolean {
  return Math.abs(dx) >= DRAG_START_PX && Math.abs(dx) > Math.abs(dy);
}

/** How far along a commit the drag is, signed (−1 = fully toward A, 1 = toward B). */
export function dragProgress(dx: number, width: number): number {
  const p = dx / Math.max(1, COMMIT_SHARE * width);
  return p < -1 ? -1 : p > 1 ? 1 : p;
}
