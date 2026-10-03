import {
  clusterLabel,
  type Dimensions,
  decadeLabel,
  P_SCALE,
  scalarLabel,
  TARGET_SCALE,
  type TasteVector,
} from "@abtune/engine";
import { useState } from "react";
import { genreEmoji, t } from "../strings.ts";

/** κ below this (×100) reads as "not enough answers yet". */
const LOW_EVIDENCE = 30;
/** |target| below this reads as balanced. */
const BALANCED = 15;

export interface ScalarReading {
  readonly dim: string;
  readonly name: string;
  readonly low: string;
  readonly high: string;
  /** Target in [-1, 1]. */
  readonly value: number;
  readonly lowEvidence: boolean;
  /** "Energetic", "Balanced", or the low-evidence note. */
  readonly leaning: string;
}

export function scalarReadings(dims: Dimensions, taste: TasteVector): ScalarReading[] {
  return dims.scalar.map((dim, i) => {
    const target = taste.target[i] ?? 0;
    const lowEvidence = (taste.weight[i] ?? 0) < LOW_EVIDENCE;
    const l = scalarLabel(dim);
    const leaning = lowEvidence
      ? t.result.lowEvidence
      : Math.abs(target) < BALANCED
        ? "Balanced"
        : target > 0
          ? l.high
          : l.low;
    return { dim, ...l, value: target / TARGET_SCALE, lowEvidence, leaning };
  });
}

const fmt = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;

/**
 * Radar of the 9 scalar targets (HANDOFF §4.3). Single series: one hue, 2px line, 10% wash, ringed
 * markers; the middle ring is "neutral" (0). Low-evidence dims sit at neutral with a hollow marker.
 */
export function Radar({ readings }: { readings: readonly ScalarReading[] }) {
  const [active, setActive] = useState<number | null>(null);
  const size = 300;
  // Crop the empty band above and below the labels (they sit at 1.2·R from the center).
  const top = 24;
  const height = size - 2 * top;
  const c = size / 2;
  const R = 92;
  const n = readings.length;
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  const point = (i: number, r: number) =>
    [c + Math.cos(angle(i)) * r * R, c + Math.sin(angle(i)) * r * R] as const;
  const radius = (x: ScalarReading) => (x.lowEvidence ? 0.5 : (x.value + 1) / 2);
  const ring = (r: number) =>
    readings
      .map((_, i) =>
        point(i, r)
          .map((v) => v.toFixed(1))
          .join(","),
      )
      .join(" ");
  const shape = readings
    .map((x, i) =>
      point(i, radius(x))
        .map((v) => v.toFixed(1))
        .join(","),
    )
    .join(" ");
  const tip = active !== null ? readings[active] : undefined;
  const tipAt = active !== null && tip ? point(active, radius(tip)) : null;

  return (
    <div className="relative mx-auto w-full max-w-[340px]">
      <svg
        viewBox={`0 ${top} ${size} ${height}`}
        className="block w-full overflow-visible"
        role="img"
        aria-label={t.result.profile}
      >
        {[0.25, 0.5, 0.75, 1].map((r) => (
          <polygon
            key={r}
            points={ring(r)}
            fill="none"
            stroke="var(--color-line)"
            strokeWidth={r === 0.5 ? 1.5 : 1}
          />
        ))}
        {readings.map((x, i) => {
          const [ex, ey] = point(i, 1);
          return (
            <line
              key={x.dim}
              x1={c}
              y1={c}
              x2={ex}
              y2={ey}
              stroke="var(--color-line)"
              strokeWidth={1}
            />
          );
        })}
        <polygon
          points={shape}
          fill="var(--color-profile)"
          fillOpacity={0.12}
          stroke="var(--color-profile)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {readings.map((x, i) => {
          const [lx, ly] = point(i, 1.2);
          const anchor = Math.abs(lx - c) < 8 ? "middle" : lx < c ? "end" : "start";
          return (
            <text
              key={x.dim}
              x={lx}
              y={ly}
              dy="0.35em"
              textAnchor={anchor}
              className="fill-text-2 text-[11px] font-semibold"
            >
              {x.high}
            </text>
          );
        })}
        {readings.map((x, i) => {
          const [px, py] = point(i, radius(x));
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG mark can't be a <button>
            <g
              key={x.dim}
              role="button"
              tabIndex={0}
              aria-label={`${x.name}: ${x.leaning}${x.lowEvidence ? "" : ` (${fmt(x.value)})`}`}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className="cursor-default outline-none"
            >
              <circle cx={px} cy={py} r={14} fill="transparent" />
              <circle
                cx={px}
                cy={py}
                r={active === i ? 6 : 4.5}
                fill={x.lowEvidence ? "var(--color-surface)" : "var(--color-profile)"}
                stroke={x.lowEvidence ? "var(--color-profile)" : "var(--color-surface)"}
                strokeWidth={2}
              />
            </g>
          );
        })}
      </svg>
      {tip && tipAt && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+12px)] whitespace-nowrap rounded-lg border border-line bg-raised px-2.5 py-1.5 text-center shadow-lg"
          style={{
            left: `${(tipAt[0] / size) * 100}%`,
            top: `${((tipAt[1] - top) / height) * 100}%`,
          }}
        >
          <div className="text-sm font-bold text-text">{tip.leaning}</div>
          <div className="text-xs text-text-3">
            {tip.name} · {tip.low} ↔ {tip.high}
          </div>
        </div>
      )}
    </div>
  );
}

/** Genres below this share are noise next to the top ones. */
const MIN_GENRE_SHARE = 0.05;

/** Top 3 genres with % (HANDOFF §4.3): one series, one hue, value at each bar's tip. */
export function GenreBars({ dims, taste }: { dims: Dimensions; taste: TasteVector }) {
  if (!taste.genres) return <p className="text-sm text-text-2">{t.result.noGenres}</p>;
  const top = dims.genres
    .map((g, i) => ({ g, i, p: (taste.genres?.[i] ?? 0) / P_SCALE }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .slice(0, 3)
    .filter((x) => x.p >= MIN_GENRE_SHARE);
  return (
    <ul className="flex flex-col gap-2.5">
      {top.map(({ g, p }) => (
        <li key={g} className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-text">
            <span aria-hidden="true">{genreEmoji(g)}</span> {clusterLabel(g)}
          </span>
          <span className="flex items-center gap-2">
            <span
              className="block h-2.5 rounded-e bg-profile"
              style={{ width: `${Math.max(2, p * 85)}%` }}
            />
            <span className="text-sm font-bold tabular-nums text-text-2">
              {Math.round(p * 100)}%
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Decade distribution as columns in chronological order; the top decade is labeled. */
export function DecadeColumns({ dims, taste }: { dims: Dimensions; taste: TasteVector }) {
  const [active, setActive] = useState<number | null>(null);
  if (!taste.decades) return <p className="text-sm text-text-2">{t.result.anyEra}</p>;
  const p = dims.decades.map((_, i) => (taste.decades?.[i] ?? 0) / P_SCALE);
  const max = Math.max(...p, 0.0001);
  const top = p.indexOf(max);
  return (
    <div className="flex h-28 items-end gap-0.5">
      {dims.decades.map((d, i) => {
        const share = p[i] ?? 0;
        const labeled = i === top || i === active;
        return (
          // A button so touch screens (no hover) can tap a column to read its share.
          <button
            type="button"
            key={d}
            aria-label={`${decadeLabel(d)}: ${Math.round(share * 100)}%`}
            className="flex h-full flex-1 cursor-default flex-col items-center justify-end gap-1 rounded"
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            onClick={() => setActive(i)}
          >
            <span
              className={`text-[11px] font-bold tabular-nums ${labeled ? "text-text" : "invisible"}`}
            >
              {Math.round(share * 100)}%
            </span>
            <span
              className={`block w-full max-w-6 rounded-t transition-opacity ${active === i ? "opacity-80" : ""}`}
              style={{
                height: `${Math.max(share > 0 ? 3 : 1, (share / max) * 68)}px`,
                backgroundColor: share > 0 ? "var(--color-profile)" : "var(--color-line)",
              }}
            />
            <span className="text-[11px] text-text-3">{decadeLabel(d)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The table twin of the charts (values without hovering). */
export function ProfileTable({
  readings,
  dims,
  taste,
}: {
  readings: readonly ScalarReading[];
  dims: Dimensions;
  taste: TasteVector;
}) {
  return (
    <table className="w-full text-start text-sm">
      <tbody>
        {readings.map((x) => (
          <tr key={x.dim} className="border-b border-line/60">
            <th scope="row" className="py-1.5 text-start font-semibold text-text-2">
              {x.name}
              <span className="block text-xs font-normal text-text-3">
                {x.low} ↔ {x.high}
              </span>
            </th>
            <td className="py-1.5 text-text">{x.leaning}</td>
            <td className="py-1.5 text-end tabular-nums text-text-2">
              {x.lowEvidence ? "–" : fmt(x.value)}
            </td>
          </tr>
        ))}
        {taste.decades &&
          dims.decades.map((d, i) => (
            <tr key={d} className="border-b border-line/60">
              <th scope="row" className="py-1.5 text-start font-semibold text-text-2">
                {decadeLabel(d)}
              </th>
              <td />
              <td className="py-1.5 text-end tabular-nums text-text-2">
                {Math.round(((taste.decades?.[i] ?? 0) / P_SCALE) * 100)}%
              </td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}
