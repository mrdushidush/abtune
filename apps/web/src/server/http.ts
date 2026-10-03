import type { Context } from "hono";

/**
 * POSTs that act for this browser come from this app's own pages: a request with an Origin header
 * from another host is refused (no Origin, e.g. curl or a same-origin GET-turned-POST, is allowed).
 */
export function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(c.req.url).host;
  } catch {
    return false;
  }
}
