import type { Context } from "hono";

/**
 * POSTs that act for this browser come from this app's own pages: a request with an Origin header
 * from another host is refused (no Origin, e.g. curl or a same-origin GET-turned-POST, is allowed).
 */
export function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  return origin ? originIsThisHost(origin, c) : true;
}

/**
 * Stricter, for POST /api/event: the request must say it comes from this site's pages. Browsers
 * send Origin on every POST (sendBeacon and fetch included); without it, a browser's
 * `Sec-Fetch-Site: same-origin` is accepted instead. Pages can set neither header, so a request
 * with neither is a script. A script can still set them; the per-visitor limit on events is what
 * bounds one.
 */
export function fromThisSite(c: Context): boolean {
  const origin = c.req.header("origin");
  if (origin) return originIsThisHost(origin, c);
  return c.req.header("sec-fetch-site") === "same-origin";
}

function originIsThisHost(origin: string, c: Context): boolean {
  try {
    return new URL(origin).host === new URL(c.req.url).host;
  } catch {
    return false;
  }
}
