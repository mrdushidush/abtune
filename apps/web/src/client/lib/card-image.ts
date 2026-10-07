// The share card as a PNG (HANDOFF §4.3 "Share link + PNG card", M6). Drawn on a canvas from the
// same numbers as the on-screen card, so it needs no HTML-to-image library and never shows answers.
import {
  archetypeName,
  clusterLabel,
  type Dimensions,
  decadeLabel,
  P_SCALE,
  type TasteVector,
  traits,
} from "@abtune/engine";
import { scalarReadings } from "../components/ProfileCharts.tsx";
import { genreEmoji, TRAIT_LABELS, t } from "../strings.ts";

export interface CardInput {
  readonly dims: Dimensions;
  readonly taste: TasteVector;
  readonly answered: number;
  /** The playlist's title and first songs. */
  readonly title: string;
  readonly tracks: readonly { readonly title: string; readonly artist: string }[];
  /** Where to get yours (the share link's host), in the footer. */
  readonly site?: string;
}

/** A 4:5 feed post, or a 9:16 story (the post card with a call to action below). */
export type CardFormat = "post" | "story";

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;
export const STORY_HEIGHT = 1920;

const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Hebrew", sans-serif, "Apple Color Emoji", "Segoe UI Emoji"`;

/** The app's palette, read from the theme so the image matches the page. */
function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    css.getPropertyValue(`--color-${name}`).trim() || fallback;
  return {
    ink: v("ink", "#0b0b12"),
    surface: v("surface", "#14141d"),
    raised: v("raised", "#1d1d29"),
    line: v("line", "#2a2a38"),
    a: v("side-a", "#ff5c8a"),
    b: v("side-b", "#4cc9f0"),
    profile: v("profile", "#9a6cf5"),
    text: v("text", "#f4f4f8"),
    text2: v("text-2", "#b9b9c8"),
    text3: v("text-3", "#85859a"),
  };
}

type Ctx = CanvasRenderingContext2D;

/** The first strongly directional character is Hebrew or Arabic. */
const FIRST_STRONG_RTL = /^[^A-Za-zÀ-ɏ֐-ࣿ]*[֐-ࣿ]/;

const font = (ctx: Ctx, weight: number, size: number) => {
  ctx.font = `${weight} ${size}px ${FONT}`;
};

/** Truncate with an ellipsis to fit `max` pixels. */
function fit(ctx: Ctx, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** Greedy word wrap into at most `lines` lines. */
function wrap(ctx: Ctx, text: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= max || !line) line = next;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  if (out.length <= lines) return out;
  const kept = out.slice(0, lines);
  kept[lines - 1] = fit(ctx, out.slice(lines - 1).join(" "), max);
  return kept;
}

function spaced(ctx: Ctx, px: number) {
  // letterSpacing is recent (Chrome 99, Safari 17); without it the label is just tighter.
  if ("letterSpacing" in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${px}px`;
}

export async function drawCard(canvas: HTMLCanvasElement, input: CardInput): Promise<void> {
  await document.fonts?.ready;
  const c = palette();
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  const W = CARD_WIDTH;
  const H = CARD_HEIGHT;
  const { dims, taste, answered } = input;

  // Ground, gradient frame, card surface.
  ctx.fillStyle = c.ink;
  ctx.fillRect(0, 0, W, H);
  const frame = ctx.createLinearGradient(40, 40, W - 40, H - 40);
  frame.addColorStop(0, c.a);
  frame.addColorStop(0.5, c.profile);
  frame.addColorStop(1, c.b);
  ctx.fillStyle = frame;
  ctx.beginPath();
  ctx.roundRect(40, 40, W - 80, H - 80, 56);
  ctx.fill();
  ctx.fillStyle = c.surface;
  ctx.beginPath();
  ctx.roundRect(45, 45, W - 90, H - 90, 52);
  ctx.fill();

  const left = 104;
  const right = W - 104;
  ctx.textBaseline = "alphabetic";

  // Header: wordmark and kicker.
  font(ctx, 900, 44);
  ctx.textAlign = "left";
  let x = left;
  for (const [part, color] of [
    ["A", c.a],
    ["B", c.b],
    ["Tune", c.text],
  ] as const) {
    ctx.fillStyle = color;
    ctx.fillText(part, x, 138);
    x += ctx.measureText(part).width;
  }
  font(ctx, 700, 22);
  spaced(ctx, 4);
  ctx.fillStyle = c.text3;
  ctx.textAlign = "right";
  ctx.fillText(t.result.yourPersonality.toUpperCase(), right, 132);
  spaced(ctx, 0);

  // Archetype name, then trait chips.
  const tr = traits(dims, taste);
  const name = archetypeName(tr);
  // The biggest size that fits on one line, else two lines.
  let size = 104;
  font(ctx, 900, size);
  while (size > 76 && ctx.measureText(name).width > right - left) {
    size -= 4;
    font(ctx, 900, size);
  }
  if (ctx.measureText(name).width > right - left) {
    size = 88;
    font(ctx, 900, size);
  }
  const nameLines = wrap(ctx, name, right - left, 2);
  ctx.fillStyle = c.text;
  ctx.textAlign = "center";
  let y = 252;
  nameLines.forEach((line, i) => {
    if (i > 0) y += size * 1.02;
    ctx.fillText(line, W / 2, y);
  });
  y += 66;
  const chips = [
    TRAIT_LABELS.energy[tr.energy],
    TRAIT_LABELS.mood[tr.mood],
    TRAIT_LABELS.era[tr.era],
    TRAIT_LABELS.texture[tr.texture],
  ];
  font(ctx, 600, 26);
  const chipW = chips.map((s) => ctx.measureText(s).width + 40);
  const gap = 12;
  let cx = W / 2 - (chipW.reduce((a, b) => a + b, 0) + gap * (chips.length - 1)) / 2;
  chips.forEach((s, i) => {
    const w = chipW[i] as number;
    ctx.fillStyle = c.raised;
    ctx.beginPath();
    ctx.roundRect(cx, y - 32, w, 46, 23);
    ctx.fill();
    ctx.fillStyle = c.text2;
    ctx.textAlign = "center";
    ctx.fillText(s, cx + w / 2, y);
    cx += w + gap;
  });

  // Radar of the 9 scalars (the middle ring is neutral; low-evidence dims sit on it, hollow).
  const readings = scalarReadings(dims, taste);
  const R = 150;
  const ox = W / 2;
  const oy = y + 40 + R * 1.2;
  const n = readings.length;
  const ang = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  const pt = (i: number, r: number) =>
    [ox + Math.cos(ang(i)) * r * R, oy + Math.sin(ang(i)) * r * R] as const;
  ctx.strokeStyle = c.line;
  for (const r of [0.25, 0.5, 0.75, 1]) {
    ctx.lineWidth = r === 0.5 ? 3 : 2;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const [px, py] = pt(i % n, r);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.lineWidth = 2;
  for (let i = 0; i < n; i++) {
    const [px, py] = pt(i, 1);
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(px, py);
    ctx.stroke();
  }
  const radius = (k: number) => {
    const r = readings[k];
    return !r || r.lowEvidence ? 0.5 : (r.value + 1) / 2;
  };
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const [px, py] = pt(i % n, radius(i % n));
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = c.profile;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = c.profile;
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.stroke();
  readings.forEach((r, i) => {
    const [px, py] = pt(i, radius(i));
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.fillStyle = r.lowEvidence ? c.surface : c.profile;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = r.lowEvidence ? c.profile : c.surface;
    ctx.stroke();
    const [lx, ly] = pt(i, 1.2);
    font(ctx, 600, 24);
    ctx.fillStyle = r.lowEvidence ? c.text3 : c.text2;
    ctx.textAlign = Math.abs(lx - ox) < 20 ? "center" : lx < ox ? "right" : "left";
    ctx.textBaseline = "middle";
    ctx.fillText(r.high, lx, ly);
    ctx.textBaseline = "alphabetic";
  });

  // Top genres (left) and era (right).
  const colTop = oy + R * 1.2 + 56;
  const mid = W / 2 + 20;
  const kicker = (text: string, kx: number) => {
    font(ctx, 700, 22);
    spaced(ctx, 3);
    ctx.fillStyle = c.text3;
    ctx.textAlign = "left";
    ctx.fillText(text.toUpperCase(), kx, colTop);
    spaced(ctx, 0);
  };
  kicker(t.result.topGenres, left);
  const genres = taste.genres
    ? dims.genres
        .map((g, i) => ({ g, i, p: (taste.genres?.[i] ?? 0) / P_SCALE }))
        .sort((a, b) => b.p - a.p || a.i - b.i)
        .slice(0, 3)
        .filter((x) => x.p >= 0.05)
    : [];
  let gy = colTop + 46;
  const barMax = mid - 60 - left - 80;
  if (genres.length === 0) {
    font(ctx, 500, 26);
    ctx.fillStyle = c.text2;
    ctx.fillText(t.result.noGenres.split(":")[0] ?? "", left, gy);
  }
  for (const { g, p } of genres) {
    font(ctx, 700, 28);
    ctx.fillStyle = c.text;
    ctx.textAlign = "left";
    ctx.fillText(fit(ctx, `${genreEmoji(g)} ${clusterLabel(g)}`, mid - 60 - left), left, gy);
    ctx.fillStyle = c.profile;
    ctx.beginPath();
    ctx.roundRect(left, gy + 14, Math.max(6, p * barMax), 16, [0, 8, 8, 0]);
    ctx.fill();
    font(ctx, 700, 24);
    ctx.fillStyle = c.text2;
    ctx.fillText(`${Math.round(p * 100)}%`, left + Math.max(6, p * barMax) + 12, gy + 30);
    gy += 64;
  }

  kicker(t.result.era, mid);
  const colW = (right - mid) / dims.decades.length;
  const base = colTop + 190;
  if (taste.decades) {
    const shares = dims.decades.map((_, i) => (taste.decades?.[i] ?? 0) / P_SCALE);
    const max = Math.max(...shares, 0.0001);
    const topI = shares.indexOf(max);
    dims.decades.forEach((d, i) => {
      const s = shares[i] ?? 0;
      const h = Math.max(s > 0 ? 6 : 2, (s / max) * 110);
      const bx = mid + i * colW + colW * 0.18;
      ctx.fillStyle = s > 0 ? c.profile : c.line;
      ctx.beginPath();
      ctx.roundRect(bx, base - h, colW * 0.64, h, [6, 6, 0, 0]);
      ctx.fill();
      font(ctx, 600, 18);
      ctx.fillStyle = c.text3;
      ctx.textAlign = "center";
      ctx.fillText(decadeLabel(d), bx + colW * 0.32, base + 28);
      if (i === topI) {
        font(ctx, 700, 22);
        ctx.fillStyle = c.text;
        ctx.fillText(`${Math.round(s * 100)}%`, bx + colW * 0.32, base - h - 12);
      }
    });
  } else {
    font(ctx, 500, 26);
    ctx.fillStyle = c.text2;
    ctx.textAlign = "left";
    ctx.fillText(t.result.anyEra, mid, colTop + 50);
  }

  // Playlist teaser and footer.
  let py = base + 72;
  ctx.textAlign = "left";
  font(ctx, 700, 22);
  spaced(ctx, 3);
  ctx.fillStyle = c.text3;
  ctx.fillText(t.share.onThePlaylist.toUpperCase(), left, py);
  spaced(ctx, 0);
  py += 46;
  font(ctx, 800, 34);
  ctx.fillStyle = c.text;
  ctx.fillText(fit(ctx, input.title, right - left), left, py);
  py += 40;
  font(ctx, 500, 26);
  for (const tr of input.tracks.slice(0, 3)) {
    if (py > H - 140) break;
    ctx.fillStyle = c.text2;
    // A Hebrew (or Arabic) line reads right to left and sits on the right edge, like the list.
    const rtl = FIRST_STRONG_RTL.test(tr.title);
    ctx.direction = rtl ? "rtl" : "ltr";
    ctx.textAlign = rtl ? "right" : "left";
    ctx.fillText(fit(ctx, `${tr.title} · ${tr.artist}`, right - left), rtl ? right : left, py);
    py += 36;
  }
  ctx.direction = "ltr";
  ctx.textAlign = "left";
  font(ctx, 600, 24);
  ctx.fillStyle = c.text3;
  ctx.fillText(t.result.builtFrom(answered), left, H - 92);
  ctx.textAlign = "right";
  if (input.site) {
    font(ctx, 800, 28);
    ctx.fillStyle = c.text;
    ctx.fillText(input.site, right, H - 92);
  } else ctx.fillText(t.share.tagline, right, H - 92);
}

/**
 * The story: the post card, a little smaller so it clears the top and bottom bars story apps draw
 * over the image, with the question and the site under it.
 */
export async function drawStory(canvas: HTMLCanvasElement, input: CardInput): Promise<void> {
  const card = document.createElement("canvas");
  await drawCard(card, input);
  const c = palette();
  canvas.width = CARD_WIDTH;
  canvas.height = STORY_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  const W = CARD_WIDTH;
  ctx.fillStyle = c.ink;
  ctx.fillRect(0, 0, W, STORY_HEIGHT);
  const scale = 0.92;
  const w = W * scale;
  const h = CARD_HEIGHT * scale;
  const top = 190;
  ctx.drawImage(card, (W - w) / 2, top, w, h);
  ctx.textAlign = "center";
  font(ctx, 800, 50);
  ctx.fillStyle = c.text;
  ctx.fillText(t.share.storyAsk, W / 2, top + h + 112);
  if (input.site) {
    font(ctx, 900, 64);
    const g = ctx.createLinearGradient(W / 2 - 220, 0, W / 2 + 220, 0);
    g.addColorStop(0, c.a);
    g.addColorStop(1, c.b);
    ctx.fillStyle = g;
    ctx.fillText(input.site, W / 2, top + h + 196);
  }
}

/** The card as a PNG blob. */
export async function cardImage(input: CardInput, format: CardFormat = "post"): Promise<Blob> {
  const canvas = document.createElement("canvas");
  await (format === "story" ? drawStory : drawCard)(canvas, input);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
}
