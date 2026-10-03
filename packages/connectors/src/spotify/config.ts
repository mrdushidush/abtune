import path from "node:path";
import { isClientId, type SpotifyConfig } from "./auth.ts";
import { MIN_SECRET_LENGTH } from "./store.ts";

/** Spotify settings from `.env` (HANDOFF §14), shared by the web app and the MCP server. */
export interface SpotifySettings {
  readonly clientId: string;
  readonly redirectUri: string;
  /** TOKEN_ENCRYPTION_KEY. */
  readonly secret: string;
  /** The encrypted connection store. */
  readonly tokenFile: string;
  /** Test seams: a fake Spotify. */
  readonly accountsBase?: string;
  readonly apiBase?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A setting Spotify needs that is missing or invalid. */
export type SpotifySetting = "SPOTIFY_CLIENT_ID" | "TOKEN_ENCRYPTION_KEY" | "SPOTIFY_REDIRECT_URI";

export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8787/callback";

export function spotifySettings(env: NodeJS.ProcessEnv, repoRoot: string): SpotifySettings {
  return {
    clientId: env.SPOTIFY_CLIENT_ID?.trim() ?? "",
    redirectUri: env.SPOTIFY_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI,
    secret: env.TOKEN_ENCRYPTION_KEY?.trim() ?? "",
    tokenFile: env.SPOTIFY_TOKEN_FILE || path.join(repoRoot, "data/spotify/tokens.json"),
  };
}

export const unconfiguredSpotify = (): SpotifySettings => ({
  clientId: "",
  redirectUri: DEFAULT_REDIRECT_URI,
  secret: "",
  tokenFile: "",
});

/**
 * Spotify accepts http only on a loopback IP (127.0.0.1 / [::1], never "localhost"), otherwise
 * https (HANDOFF §3.1).
 */
export function redirectProblem(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return true;
  }
  if (u.hash || u.search) return true;
  if (u.protocol === "https:") return false;
  return !(u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]"));
}

export function missingSettings(s: SpotifySettings): SpotifySetting[] {
  const out: SpotifySetting[] = [];
  if (!isClientId(s.clientId)) out.push("SPOTIFY_CLIENT_ID");
  if (s.secret.length < MIN_SECRET_LENGTH) out.push("TOKEN_ENCRYPTION_KEY");
  if (redirectProblem(s.redirectUri)) out.push("SPOTIFY_REDIRECT_URI");
  return out;
}

export function spotifyConfig(s: SpotifySettings): SpotifyConfig {
  return {
    clientId: s.clientId,
    redirectUri: s.redirectUri,
    ...(s.accountsBase ? { accountsBase: s.accountsBase } : {}),
    ...(s.apiBase ? { apiBase: s.apiBase } : {}),
    ...(s.fetch ? { fetch: s.fetch } : {}),
    ...(s.sleep ? { sleep: s.sleep } : {}),
  };
}
