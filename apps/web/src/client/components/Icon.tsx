/**
 * Line icons for buttons. Arrow and shuffle characters (⬇ ↗ 🔀) are emoji in some fonts: a blue tile
 * on Windows and Android, the wrong size next to the label.
 */
const PATHS = {
  download: "M12 3v12m-5-5 5 5 5-5M5 21h14",
  share: "M12 15V3M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7",
  shuffle: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  chevron: "m6 9 6 6 6-6",
  plus: "M12 5v14M5 12h14",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "size-5" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * The result screen's three-across buttons (Export, Share, Reshuffle): icon over label on a phone,
 * where the row is ~100 px a button, side by side from `sm`.
 */
export const TILE =
  "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 rounded-2xl bg-raised px-2 text-sm font-bold text-text hover:bg-line disabled:opacity-40 sm:min-h-12 sm:flex-row sm:gap-1.5 sm:px-4 sm:text-base";
