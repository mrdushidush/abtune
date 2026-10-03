import {
  type AnswerEvent,
  type Bank,
  bankIndex,
  clusterLabel,
  type Dimensions,
  decadeLabel,
  languageLabel,
  P_SCALE,
  scalarLabel,
  TARGET_SCALE,
  type TasteVector,
} from "@abtune/engine";

/** How sure the profile is about a scalar, from its κ (0–100). */
function sureness(weight: number): string {
  if (weight >= 70) return "sure";
  if (weight >= 35) return "fairly sure";
  return "a hint";
}

function groupLine(
  name: string,
  keys: readonly string[],
  p: readonly number[] | null,
  label: (k: string) => string,
): string {
  if (!p) return `${name}: no preference yet`;
  const parts = keys
    .map((k, i) => ({ k, share: (p[i] ?? 0) / P_SCALE }))
    .filter((x) => x.share >= 0.05)
    .sort((a, b) => b.share - a.share)
    .map((x) => `${label(x.k)} [${x.k}] ${Math.round(x.share * 100)}%`);
  return `${name}: ${parts.length ? parts.join(", ") : "spread evenly"}`;
}

/**
 * A taste vector as short English lines for a prompt: the group mixes (≥ 5%, label and [key]), then
 * each scalar by key with its two ends, the side it leans to, its value and how sure the profile
 * is. Deterministic.
 */
export function tasteSummary(dims: Dimensions, taste: TasteVector): string {
  const lines = [
    groupLine("Genres", dims.genres, taste.genres, clusterLabel),
    groupLine("Decades", dims.decades, taste.decades, decadeLabel),
    groupLine("Languages", dims.languages, taste.languages, languageLabel),
  ];
  dims.scalar.forEach((dim, d) => {
    const l = scalarLabel(dim);
    const w = taste.weight[d] ?? 0;
    const t = (taste.target[d] ?? 0) / TARGET_SCALE;
    const side = t > 0.15 ? l.high : t < -0.15 ? l.low : "middle";
    lines.push(
      w === 0
        ? `${dim} (${l.low} ↔ ${l.high}): unknown`
        : `${dim} (${l.low} ↔ ${l.high}): ${side} (${t >= 0 ? "+" : ""}${t.toFixed(2)}, ${sureness(w)})`,
    );
  });
  return lines.join("\n");
}

const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;

/**
 * Answers as prompt lines (§10.3: "chose 'Bon Jovi' over 'Britney Spears'"), with the question when
 * the card has one. The caller filters with `answersForAi` first; unknown ids and skips are dropped.
 */
export function answerLines(bank: Bank, log: readonly AnswerEvent[]): string[] {
  const { byId } = bankIndex(bank);
  const out: string[] = [];
  for (const e of log) {
    const q = byId.get(e.id);
    if (!q || e.choice === "skip") continue;
    const asked = q.q ? ` (asked: ${quote(q.q)})` : "";
    if (e.choice === "both")
      out.push(`- liked both ${quote(q.a.label)} and ${quote(q.b.label)}${asked}`);
    else {
      const [chose, over] = e.choice === "a" ? [q.a, q.b] : [q.b, q.a];
      out.push(`- chose ${quote(chose.label)} over ${quote(over.label)}${asked}`);
    }
  }
  return out;
}

/** Control characters (C0, DEL, C1). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Model text for display: control characters and surrounding quotes removed, whitespace collapsed,
 * cut to `max` characters (on a word when it can be). Null when nothing is left.
 */
export function cleanText(s: unknown, max: number): string | null {
  if (typeof s !== "string") return null;
  let t = s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "").trim();
  const chars = [...t];
  if (chars.length > max) {
    const cut = chars.slice(0, max - 1).join("");
    const space = cut.lastIndexOf(" ");
    t = `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return t.length > 0 ? t : null;
}

/** The keys a model may boost, for the prompt: "Genres: classic_rock (Classic Rock), …". */
export function keyList(dims: Dimensions): string {
  return [
    `Genres: ${dims.genres.map((k) => `${k} (${clusterLabel(k)})`).join(", ")}`,
    `Decades: ${dims.decades.map((k) => `${k} (${decadeLabel(k)})`).join(", ")}`,
  ].join("\n");
}
