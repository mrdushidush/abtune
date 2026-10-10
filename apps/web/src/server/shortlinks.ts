// Typed short links for a public instance: /x, /ig and /tt, printed on the site's own cards and
// clips, because Instagram and TikTok captions aren't clickable and people type what they see. Each
// one sends the browser on to /?via=<tag>, where the page counts the visit like any tagged link
// (client/state/via.ts), and the server counts the hit itself (`shortlink_<tag>`).
import type { Context } from "hono";
import { VIA_TAGS, type ViaTag } from "../api-types.ts";

/** The tag a short link's path names, in any case and with or without one trailing slash. */
export function shortLinkTag(pathname: string): ViaTag | null {
  const name = pathname.replace(/^\/|\/$/g, "").toLowerCase();
  return (VIA_TAGS as readonly string[]).includes(name) ? (name as ViaTag) : null;
}

/**
 * Link previews, crawlers and headless browsers that say what they are. A plain script sends no
 * Sec-Fetch-Mode, so it isn't counted anyway.
 */
const NOT_A_PERSON = /bot\b|crawl|spider|headless|preview|facebookexternalhit/i;

/**
 * Whether a hit looks like someone opening the link: a browser navigating to it (Sec-Fetch-Mode,
 * which browsers send and pages can't set) with a User-Agent that doesn't name a bot. X, Telegram
 * and WhatsApp fetch a link for its preview when it's posted, and that isn't a visit. A browser
 * too old to send Sec-Fetch-Mode isn't counted either: an undercount, never a double.
 */
export function looksLikeAVisit(c: Context): boolean {
  if (c.req.method !== "GET" || c.req.header("sec-fetch-mode") !== "navigate") return false;
  const agent = c.req.header("user-agent");
  return agent !== undefined && agent !== "" && !NOT_A_PERSON.test(agent);
}
