/**
 * Seeded PRNG (sfc32). Pure 32-bit integer arithmetic (adds truncated with `| 0`, shifts, xor),
 * so the stream is bit-identical in every JavaScript engine. Never use Math.random in the engine.
 */
export interface Rng {
  /** Uniform 32-bit unsigned integer. */
  nextUint32(): number;
  /** Uniform float in [0, 1) with 32 bits of resolution. */
  next(): number;
  /** Uniform integer in [0, n), unbiased (rejection sampling). */
  int(n: number): number;
}

/** `seedHex` is the 16-hex-char (64-bit) seed from `computeSeed`. */
export function createRng(seedHex: string): Rng {
  if (!/^[0-9a-f]{16}$/.test(seedHex))
    throw new Error(`createRng: expected 16 hex chars, got "${seedHex}"`);
  let a = Number.parseInt(seedHex.slice(0, 8), 16) | 0;
  let b = Number.parseInt(seedHex.slice(8, 16), 16) | 0;
  let c = 0x9e3779b9 | 0;
  let d = 1;

  const nextUint32 = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  // Warm up so similar seeds diverge.
  for (let i = 0; i < 15; i++) nextUint32();

  return {
    nextUint32,
    next: () => nextUint32() / 4294967296,
    int(n) {
      if (!Number.isInteger(n) || n <= 0 || n > 4294967296)
        throw new Error(`Rng.int: bad bound ${n}`);
      const limit = 4294967296 - (4294967296 % n);
      let x = nextUint32();
      while (x >= limit) x = nextUint32();
      return x % n;
    },
  };
}
