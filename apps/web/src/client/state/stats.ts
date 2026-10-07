// Usage events for a server that counts them (health `stats`, a public instance): an event name and
// nothing else, so the server can count finished quizzes, shares and exports but tell no one apart.
import type { StatEvent } from "../../api-types.ts";

/** null until the server's health says whether it counts; events wait for that. */
let counting: boolean | null = null;
const waiting: StatEvent[] = [];

function send(e: StatEvent): void {
  try {
    const body = JSON.stringify({ e });
    // text/plain keeps the beacon a simple request; the server parses the JSON itself.
    if (!navigator.sendBeacon?.("/api/event", new Blob([body], { type: "text/plain" })))
      fetch("/api/event", { method: "POST", body, keepalive: true }).catch(() => {});
  } catch {
    // Counting is best effort.
  }
}

/** Called with the server's health: send what waited, or drop it. */
export function setCounting(on: boolean): void {
  counting = on;
  const queued = waiting.splice(0);
  if (on) for (const e of queued) send(e);
}

export function track(e: StatEvent): void {
  if (counting === null) {
    if (waiting.length < 20) waiting.push(e);
  } else if (counting) send(e);
}

const SEEN_KEY = "abtune.counted";
const SEEN_MAX = 50;

/**
 * `track` once per `key` on this device (a quiz's seed, a share code), so reloading a result or
 * reopening a link isn't another quiz.
 */
export function trackOnce(e: StatEvent, key: string): void {
  const id = `${e}:${key}`;
  let seen: string[] = [];
  try {
    seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[];
    if (!Array.isArray(seen)) seen = [];
  } catch {
    seen = [];
  }
  if (seen.includes(id)) return;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, id].slice(-SEEN_MAX)));
  } catch {
    // Without storage it may count twice; fine.
  }
  track(e);
}
