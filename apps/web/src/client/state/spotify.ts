import type {
  PlaylistRequest,
  SpotifyApiError,
  SpotifyOutcome,
  SpotifyPushRequest,
  SpotifyPushResponse,
  SpotifyStatus,
} from "../../api-types.ts";
import { call } from "./api.ts";
import type { HealthState } from "./hooks.ts";

// Spotify from the browser (HANDOFF §11.1). The browser never sees a Spotify token: the server
// signs in, stores the connection and pushes; an HttpOnly cookie names this browser's connection.

export const fetchSpotifyStatus = () => call<SpotifyStatus>("/api/spotify");

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether to show "Save to Spotify": always once it's set up. Before that, only on this machine
 * (loopback), where the person who can set it up is: a visitor elsewhere would get a guide to the
 * server's `.env`. Shown while health is unknown; the sheet handles a server that's down.
 */
export function offerSpotify(health: HealthState, hostname: string): boolean {
  return health.kind !== "ok" || health.health.spotify.configured || LOOPBACK.has(hostname);
}

export const postSpotifyPush = (body: SpotifyPushRequest) =>
  call<SpotifyPushResponse, SpotifyApiError>("/api/spotify/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const postSpotifyDisconnect = () =>
  call<{ ok: true }, SpotifyApiError>("/api/spotify/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

/** Where "Connect Spotify" goes: the server's sign-in, then back to `returnTo` (path + hash). */
export const loginHref = (returnTo: string) =>
  `/api/spotify/login?return=${encodeURIComponent(returnTo)}`;

/**
 * The push body: the songs on screen by id and the first playlist's request (its taste and seed
 * pick replacements). Like every request, no answers (HANDOFF §13).
 */
export function pushRequest(
  name: string,
  description: string,
  isPublic: boolean,
  tracks: readonly { readonly track_id: string }[],
  request: PlaylistRequest,
): SpotifyPushRequest {
  return {
    name,
    description,
    public: isPublic,
    tracks: tracks.map((t) => t.track_id),
    request,
  };
}

const OUTCOMES: readonly SpotifyOutcome[] = [
  "connected",
  "denied",
  "not_allowed",
  "not_configured",
  "expired",
  "error",
];

/** The `?spotify=` the sign-in came back with, removed from the address bar. */
export function takeOutcome(): SpotifyOutcome | null {
  const params = new URLSearchParams(location.search);
  const raw = params.get("spotify");
  if (raw === null) return null;
  params.delete("spotify");
  const search = params.toString();
  history.replaceState(
    null,
    "",
    `${location.pathname}${search ? `?${search}` : ""}${location.hash}`,
  );
  return (OUTCOMES as readonly string[]).includes(raw) ? (raw as SpotifyOutcome) : "error";
}

/** A TOKEN_ENCRYPTION_KEY for the setup wizard: 32 random bytes, base64url (43 characters). */
export function newTokenKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
