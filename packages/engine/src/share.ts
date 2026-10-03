import {
  ADJUST_KINDS,
  type AdjustKind,
  isEmptyAdjust,
  type TasteAdjust,
  validateAdjust,
} from "./adjust.ts";
import { GROUPS } from "./dims.ts";
import { MAX_SHORTLIST } from "./generate/rerank.ts";
import { type TasteVector, validateTaste } from "./taste.ts";
import { TWEAK_AXES, type TweakAxis, type TweakSteps, validateTweaks } from "./tweak.ts";
import type { Dimensions } from "./types.ts";

/**
 * A share link (HANDOFF §4.4): enough to rebuild the personality card and the exact playlist on
 * another device, and nothing about the answers. The card is computed from the untweaked taste, and
 * the playlist from the taste with the tweaks applied, as on the result screen.
 */
export interface ShareData {
  /** The quantized profile, before tweaks. */
  readonly taste: TasteVector;
  readonly tweaks: TweakSteps;
  /** The playlist seed (16 hex chars), reshuffles included. */
  readonly seed: string;
  readonly length: number;
  /** Non-skip answers: the card's "Built from N answers". */
  readonly answered: number;
  /** `engineVersion(bank)` and the catalog version that made the playlist. */
  readonly engineVersion: string;
  readonly catalogVersion: string;
  /** "+25 deeper cuts" pages and swaps applied on top of the first playlist, in order. */
  readonly ops: readonly ShareOp[];
  /**
   * The free-text tweak's adjustment (AI T3), applied to `taste` before the tweaks: the playlist's
   * base (`playlistBase`). The card shows `taste` without it.
   */
  readonly adjust?: TasteAdjust;
  /** AI rerank (T2): the first page's shortlist positions, ascending (see `playShortlist`). */
  readonly picks?: readonly number[];
  /** The AI's playlist title and blurb (T1/T3). Never set when sensitive answers went to the AI. */
  readonly title?: string;
  readonly blurb?: string;
}

export type ShareOp = { readonly op: "more" } | { readonly op: "swap"; readonly index: number };

/** Binary layout version (first byte): 1, or 2 when an AI field is set. */
export const SHARE_FORMAT = 1;
export const SHARE_FORMAT_AI = 2;
export const MAX_TITLE_CHARS = 60;
export const MAX_BLURB_CHARS = 160;
/** Format 2 flags. */
const HAS_ADJUST = 1;
const HAS_PICKS = 2;
const HAS_TITLE = 4;
const HAS_BLURB = 8;
export const MAX_SHARE_OPS = 100;
export const MAX_SHARE_LENGTH = 1000;
const MAX_STRING_BYTES = 64;
/** Version strings are printable ASCII (no text codecs needed: the engine runs anywhere). */
const ASCII = /^[\x20-\x7e]*$/;
/** Answer counts above this are not plausible (no bank is that big). */
const MAX_ANSWERED = 10_000;

export class ShareError extends Error {
  override name = "ShareError";
}

class Writer {
  private readonly bytes: number[] = [];
  byte(b: number): void {
    this.bytes.push(b & 0xff);
  }
  /** Unsigned LEB128. */
  uint(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new ShareError(`share: bad unsigned ${n}`);
    let x = n;
    while (x >= 0x80) {
      this.byte((x % 0x80) | 0x80);
      x = Math.floor(x / 0x80);
    }
    this.byte(x);
  }
  /** Zigzag, then LEB128. */
  int(n: number): void {
    if (!Number.isSafeInteger(n)) throw new ShareError(`share: bad integer ${n}`);
    this.uint(n >= 0 ? 2 * n : -2 * n - 1);
  }
  string(s: string): void {
    if (s.length > MAX_STRING_BYTES || !ASCII.test(s)) throw new ShareError("share: bad string");
    this.uint(s.length);
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  /** UTF-8 with a byte-length prefix (written by hand: the engine uses no text codecs). */
  text(s: string): void {
    const bytes: number[] = [];
    for (const ch of s) {
      const c = ch.codePointAt(0) as number;
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else
        bytes.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 63),
          0x80 | ((c >> 6) & 63),
          0x80 | (c & 63),
        );
    }
    this.uint(bytes.length);
    for (const b of bytes) this.byte(b);
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

class Reader {
  private at = 0;
  private readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  byte(): number {
    if (this.at >= this.b.length) throw new ShareError("share: truncated");
    return this.b[this.at++] as number;
  }
  uint(): number {
    let n = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const x = this.byte();
      n += (x & 0x7f) * scale;
      if (x < 0x80) return n;
      scale *= 0x80;
    }
    throw new ShareError("share: number too long");
  }
  int(): number {
    const z = this.uint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }
  string(): string {
    const n = this.uint();
    if (n > MAX_STRING_BYTES) throw new ShareError("share: bad string");
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.byte());
    if (!ASCII.test(s)) throw new ShareError("share: bad string");
    return s;
  }
  /** UTF-8 written by `Writer.text`. Rejects malformed and overlong sequences. */
  text(maxBytes: number): string {
    const n = this.uint();
    if (n > maxBytes) throw new ShareError("share: text too long");
    const end = this.at + n;
    let s = "";
    while (this.at < end) {
      const b = this.byte();
      const extra =
        b < 0x80
          ? 0
          : b >= 0xf0 && b < 0xf5
            ? 3
            : b >= 0xe0 && b < 0xf0
              ? 2
              : b >= 0xc2 && b < 0xe0
                ? 1
                : -1;
      if (extra < 0 || this.at + extra > end) throw new ShareError("share: bad text");
      let c = extra === 0 ? b : b & (0x3f >> extra);
      for (let k = 0; k < extra; k++) {
        const x = this.byte();
        if ((x & 0xc0) !== 0x80) throw new ShareError("share: bad text");
        c = (c << 6) | (x & 63);
      }
      const min = [0, 0x80, 0x800, 0x10000][extra] as number;
      if (c < min || c > 0x10ffff || (c >= 0xd800 && c < 0xe000))
        throw new ShareError("share: bad text");
      s += String.fromCodePoint(c);
    }
    return s;
  }
  end(): void {
    if (this.at !== this.b.length) throw new ShareError("share: trailing bytes");
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding (RFC 4648 §5). */
function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let k = 0; k < chars; k++) out += B64[(n >> (18 - 6 * k)) & 63];
  }
  return out;
}

function fromBase64Url(code: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(code) || code.length % 4 === 1)
    throw new ShareError("share: not base64url");
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of code) {
    acc = ((acc << 6) | B64.indexOf(ch)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  // Leftover bits must be zero padding, so a code has exactly one spelling.
  if ((acc & ((1 << bits) - 1)) !== 0) throw new ShareError("share: not base64url");
  return Uint8Array.from(out);
}

/** Throws ShareError unless `data` is a well-formed share for `dims`. */
export function validateShare(dims: Dimensions, data: ShareData): void {
  try {
    validateTaste(dims, data.taste);
    validateTweaks(data.tweaks);
  } catch (err) {
    throw new ShareError((err as Error).message);
  }
  if (!/^[0-9a-f]{16}$/.test(data.seed)) throw new ShareError("share: bad seed");
  if (!Number.isInteger(data.length) || data.length < 1 || data.length > MAX_SHARE_LENGTH)
    throw new ShareError("share: bad length");
  if (!Number.isInteger(data.answered) || data.answered < 0 || data.answered > MAX_ANSWERED)
    throw new ShareError("share: bad answer count");
  if (data.ops.length > MAX_SHARE_OPS) throw new ShareError("share: too many edits");
  for (const op of data.ops) {
    if (op.op === "swap" && (!Number.isInteger(op.index) || op.index < 0))
      throw new ShareError("share: bad swap");
    if (op.op !== "more" && op.op !== "swap") throw new ShareError("share: bad edit");
  }
  if (data.adjust !== undefined) {
    try {
      validateAdjust(dims, data.adjust);
    } catch (err) {
      throw new ShareError((err as Error).message);
    }
  }
  if (data.picks !== undefined) {
    const p = data.picks;
    if (p.length === 0 || p.length > Math.min(data.length, MAX_SHORTLIST))
      throw new ShareError("share: bad picks");
    p.forEach((x, i) => {
      if (
        !Number.isInteger(x) ||
        x < 0 ||
        x >= MAX_SHORTLIST ||
        (i > 0 && x <= (p[i - 1] as number))
      )
        throw new ShareError("share: bad picks");
    });
  }
  checkText(data.title, MAX_TITLE_CHARS);
  checkText(data.blurb, MAX_BLURB_CHARS);
}

/** Control characters (C0, DEL, C1): never in a title or blurb. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Titles and blurbs: 1 to `max` characters, no control characters. */
function checkText(s: string | undefined, max: number): void {
  if (s === undefined) return;
  if (typeof s !== "string" || s.length === 0 || [...s].length > max || CONTROL.test(s))
    throw new ShareError("share: bad text");
}

/** Which format 2 fields `data` carries (0 = none: the code is format 1). */
function aiFlags(data: ShareData): number {
  return (
    (data.adjust && !isEmptyAdjust(data.adjust) ? HAS_ADJUST : 0) |
    (data.picks ? HAS_PICKS : 0) |
    (data.title ? HAS_TITLE : 0) |
    (data.blurb ? HAS_BLURB : 0)
  );
}

const adjustKeys = (dims: Dimensions, kind: AdjustKind) =>
  kind === "scalar" ? dims.scalar : dims[kind];

/**
 * The share code: a compact binary layout, base64url (about 200 characters). Layout v1: format
 * byte, engine version, catalog version, 8 seed bytes, length, answered, the taste vector (each
 * array with its length; a group with no preference has length 0), one step count per tweak axis,
 * then the edits (0 = more, 1 + i = swap position i).
 */
export function encodeShare(dims: Dimensions, data: ShareData): string {
  validateShare(dims, data);
  const flags = aiFlags(data);
  const w = new Writer();
  w.byte(flags ? SHARE_FORMAT_AI : SHARE_FORMAT);
  w.string(data.engineVersion);
  w.string(data.catalogVersion);
  for (let i = 0; i < 16; i += 2) w.byte(Number.parseInt(data.seed.slice(i, i + 2), 16));
  w.uint(data.length);
  w.uint(data.answered);
  w.uint(data.taste.target.length);
  for (const x of data.taste.target) w.int(x);
  for (const x of data.taste.weight) w.uint(x);
  for (const g of GROUPS) {
    const p = data.taste[g];
    w.uint(p ? p.length : 0);
    for (const x of p ?? []) w.uint(x);
  }
  for (const axis of TWEAK_AXES) w.int(data.tweaks[axis] ?? 0);
  w.uint(data.ops.length);
  for (const op of data.ops) w.uint(op.op === "more" ? 0 : 1 + op.index);
  if (flags) {
    w.byte(flags);
    if (flags & HAS_ADJUST) {
      for (const kind of ADJUST_KINDS) {
        const entries = adjustKeys(dims, kind)
          .map((k, i) => [i, data.adjust?.[kind][k] ?? 0] as const)
          .filter(([, v]) => v !== 0);
        w.uint(entries.length);
        for (const [i, v] of entries) {
          w.uint(i);
          w.int(v);
        }
      }
    }
    if (flags & HAS_PICKS) {
      const picks = data.picks ?? [];
      w.uint(picks.length);
      picks.forEach((p, i) => {
        w.uint(i === 0 ? p : p - (picks[i - 1] as number) - 1);
      });
    }
    if (flags & HAS_TITLE) w.text(data.title ?? "");
    if (flags & HAS_BLURB) w.text(data.blurb ?? "");
  }
  return toBase64Url(w.done());
}

/** Parse and validate a share code against this bank's dimensions. Throws ShareError. */
export function decodeShare(dims: Dimensions, code: string): ShareData {
  const r = new Reader(fromBase64Url(code));
  const format = r.byte();
  if (format !== SHARE_FORMAT && format !== SHARE_FORMAT_AI)
    throw new ShareError(`share: unknown format ${format}`);
  const engineVersion = r.string();
  const catalogVersion = r.string();
  let seed = "";
  for (let i = 0; i < 8; i++) seed += r.byte().toString(16).padStart(2, "0");
  const length = r.uint();
  const answered = r.uint();
  const n = r.uint();
  if (n !== dims.scalar.length) throw new ShareError(`share: expected ${dims.scalar.length} dims`);
  const target = Array.from({ length: n }, () => r.int());
  const weight = Array.from({ length: n }, () => r.uint());
  const groups = {} as Record<(typeof GROUPS)[number], number[] | null>;
  for (const g of GROUPS) {
    const k = r.uint();
    if (k !== 0 && k !== dims[g].length)
      throw new ShareError(`share: expected ${dims[g].length} ${g}`);
    groups[g] = k === 0 ? null : Array.from({ length: k }, () => r.uint());
  }
  const tweaks: Partial<Record<TweakAxis, number>> = {};
  for (const axis of TWEAK_AXES) {
    const v = r.int();
    if (v !== 0) tweaks[axis] = v;
  }
  const count = r.uint();
  if (count > MAX_SHARE_OPS) throw new ShareError("share: too many edits");
  const ops: ShareOp[] = [];
  for (let i = 0; i < count; i++) {
    const x = r.uint();
    ops.push(x === 0 ? { op: "more" } : { op: "swap", index: x - 1 });
  }
  const ai = format === SHARE_FORMAT_AI ? readAiFields(r, dims) : {};
  r.end();
  const data: ShareData = {
    taste: { target, weight, ...groups },
    tweaks,
    seed,
    length,
    answered,
    engineVersion,
    catalogVersion,
    ops,
    ...ai,
  };
  validateShare(dims, data);
  return data;
}

/** Format 2's tail: a flags byte, then each flagged field in flag order. */
function readAiFields(
  r: Reader,
  dims: Dimensions,
): Pick<ShareData, "adjust" | "picks" | "title" | "blurb"> {
  const flags = r.byte();
  if (flags === 0 || flags > 15) throw new ShareError("share: bad flags");
  const out: { adjust?: TasteAdjust; picks?: number[]; title?: string; blurb?: string } = {};
  if (flags & HAS_ADJUST) {
    const adjust: Record<AdjustKind, Record<string, number>> = {
      scalar: {},
      genres: {},
      decades: {},
    };
    for (const kind of ADJUST_KINDS) {
      const keys = adjustKeys(dims, kind);
      const count = r.uint();
      if (count > keys.length) throw new ShareError("share: bad adjust");
      for (let i = 0; i < count; i++) {
        const key = keys[r.uint()];
        if (key === undefined || key in adjust[kind]) throw new ShareError("share: bad adjust");
        const v = r.int();
        if (v === 0) throw new ShareError("share: bad adjust"); // one spelling per code
        adjust[kind][key] = v;
      }
    }
    out.adjust = adjust;
  }
  if (flags & HAS_PICKS) {
    const count = r.uint();
    if (count > MAX_SHORTLIST) throw new ShareError("share: too many picks");
    const picks: number[] = [];
    for (let i = 0; i < count; i++) {
      const d = r.uint();
      picks.push(i === 0 ? d : (picks[i - 1] as number) + d + 1);
    }
    out.picks = picks;
  }
  // UTF-8 takes at most four bytes per character.
  if (flags & HAS_TITLE) out.title = r.text(4 * MAX_TITLE_CHARS);
  if (flags & HAS_BLURB) out.blurb = r.text(4 * MAX_BLURB_CHARS);
  return out;
}
