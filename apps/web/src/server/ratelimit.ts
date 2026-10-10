import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiError } from "../api-types.ts";

/**
 * Requests per visitor: playlists (PLAYLISTS_PER_MINUTE) or usage events (EVENTS_PER_MINUTE), with
 * TRUST_PROXY. Off unless a number is set.
 */
export interface RateLimitSettings {
  /** Requests a minute per visitor; a visitor may also spend a whole minute's worth at once. */
  readonly perMinute: number;
  /** Behind a reverse proxy: the visitor is the last X-Forwarded-For address, which it adds. */
  readonly trustProxy: boolean;
}

export type RateLimitVariable = "PLAYLISTS_PER_MINUTE" | "EVENTS_PER_MINUTE";

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v?.trim() ?? "");

/** From the environment; a bad value leaves the limit off and is reported, so the app still starts. */
export function rateLimitSettings(
  env: Record<string, string | undefined>,
  variable: RateLimitVariable = "PLAYLISTS_PER_MINUTE",
): {
  settings: RateLimitSettings | null;
  problem: string | null;
} {
  const raw = env[variable]?.trim();
  if (!raw) return { settings: null, problem: null };
  const perMinute = Number(raw);
  if (!Number.isInteger(perMinute) || perMinute < 1)
    return { settings: null, problem: `${variable} must be a whole number ≥ 1` };
  return { settings: { perMinute, trustProxy: truthy(env.TRUST_PROXY) }, problem: null };
}

/**
 * Who a request comes from: the address, with an IPv6 one cut to its /64 (one home or phone gets a
 * whole /64 and can rotate through it). Behind a proxy that isn't trusted, every visitor is the
 * proxy, so TRUST_PROXY is for setups where only the proxy can reach the app.
 */
export function clientKey(c: Context, trustProxy: boolean): string {
  let address = trustProxy ? c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() : undefined;
  if (!address) {
    try {
      address = getConnInfo(c).remote.address;
    } catch {
      // No socket (app.request in tests).
    }
  }
  return address ? addressKey(address) : "unknown";
}

export function addressKey(address: string): string {
  const a = address.replace(/%.*$/, "").toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1] as string;
  if (!a.includes(":")) return a;
  const [head = "", tail] = a.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"),
          ...right,
        ];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** A token bucket per visitor: `perMinute` tokens, refilled evenly over a minute. */
export class RateLimiter {
  readonly perMinute: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();
  readonly #perMs: number;
  #swept: number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.#now = now;
    this.#perMs = perMinute / 60_000;
    this.#swept = now();
  }

  /** Spend one token: 0 when allowed, else the whole seconds until the next one. */
  take(key: string): number {
    const now = this.#now();
    // A bucket left alone for a minute is full again, the same as no bucket.
    if (now - this.#swept >= 60_000) {
      for (const [k, b] of this.#buckets) if (now - b.at >= 60_000) this.#buckets.delete(k);
      this.#swept = now;
    }
    const b = this.#buckets.get(key);
    const tokens = b
      ? Math.min(this.perMinute, b.tokens + (now - b.at) * this.#perMs)
      : this.perMinute;
    if (tokens >= 1) {
      this.#buckets.set(key, { tokens: tokens - 1, at: now });
      return 0;
    }
    this.#buckets.set(key, { tokens, at: now });
    // Less a hair, so float error doesn't round a whole second up to the next.
    return Math.max(1, Math.ceil((1 - tokens) / this.#perMs / 1000 - 1e-9));
  }

  get size(): number {
    return this.#buckets.size;
  }
}

/** 429 `rate_limited` with Retry-After once a visitor's tokens run out. */
export function rateLimit(
  settings: RateLimitSettings,
  what: "playlists" | "events" = "playlists",
  limiter?: RateLimiter,
): MiddlewareHandler {
  const buckets = limiter ?? new RateLimiter(settings.perMinute);
  return async (c, next) => {
    const wait = buckets.take(clientKey(c, settings.trustProxy));
    if (wait === 0) return next();
    c.header("Retry-After", String(wait));
    return c.json(
      {
        error: "rate_limited",
        message: `Too many ${what} at once. Try again in ${wait} s.`,
        retry_after: wait,
      } satisfies ApiError,
      429,
    );
  };
}
