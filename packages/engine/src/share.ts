import { GROUPS } from "./dims.ts";
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
}

export type ShareOp = { readonly op: "more" } | { readonly op: "swap"; readonly index: number };

/** Binary layout version (first byte). */
export const SHARE_FORMAT = 1;
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
}

/**
 * The share code: a compact binary layout, base64url (about 200 characters). Layout v1: format
 * byte, engine version, catalog version, 8 seed bytes, length, answered, the taste vector (each
 * array with its length; a group with no preference has length 0), one step count per tweak axis,
 * then the edits (0 = more, 1 + i = swap position i).
 */
export function encodeShare(dims: Dimensions, data: ShareData): string {
  validateShare(dims, data);
  const w = new Writer();
  w.byte(SHARE_FORMAT);
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
  return toBase64Url(w.done());
}

/** Parse and validate a share code against this bank's dimensions. Throws ShareError. */
export function decodeShare(dims: Dimensions, code: string): ShareData {
  const r = new Reader(fromBase64Url(code));
  const format = r.byte();
  if (format !== SHARE_FORMAT) throw new ShareError(`share: unknown format ${format}`);
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
  };
  validateShare(dims, data);
  return data;
}
