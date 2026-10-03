// Authorization Code + PKCE against Spotify's accounts service (HANDOFF §11.1). PKCE needs no
// client secret, so a self-hoster only pastes the Client ID of their own Spotify app.
import { createHash, randomBytes } from "node:crypto";
import { SpotifyError } from "./errors.ts";

/** Create and fill playlists, private or public. Nothing else. */
export const SPOTIFY_SCOPES = ["playlist-modify-private", "playlist-modify-public"] as const;

export const ACCOUNTS_BASE = "https://accounts.spotify.com";
export const API_BASE = "https://api.spotify.com/v1";

export interface SpotifyConfig {
  readonly clientId: string;
  /** Exactly as registered in the Spotify dashboard, e.g. http://127.0.0.1:8787/callback. */
  readonly redirectUri: string;
  // Test seams: a fake Spotify, a fake clock, no real waiting.
  readonly accountsBase?: string;
  readonly apiBase?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Per request (default 15 s). */
  readonly timeoutMs?: number;
}

export interface TokenSet {
  readonly access_token: string;
  readonly refresh_token: string;
  /** Epoch ms. */
  readonly expires_at: number;
  readonly scope: string;
}

/** Spotify Client IDs are 32 hex characters. */
export const isClientId = (s: string) => /^[0-9a-f]{32}$/i.test(s);

/** A fresh PKCE verifier (86 base64url chars; RFC 7636 allows 43–128) and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export function authorizeUrl(
  cfg: SpotifyConfig,
  { state, challenge }: { state: string; challenge: string },
): string {
  const url = new URL("/authorize", cfg.accountsBase ?? ACCOUNTS_BASE);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: SPOTIFY_SCOPES.join(" "),
    state,
  }).toString();
  return url.toString();
}

export function exchangeCode(cfg: SpotifyConfig, code: string, verifier: string) {
  return tokenRequest(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    code_verifier: verifier,
  });
}

/** A refresh may or may not rotate the refresh token; without a new one, the old one stays valid. */
export function refreshTokens(cfg: SpotifyConfig, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(
    cfg,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: cfg.clientId },
    refreshToken,
  );
}

async function tokenRequest(
  cfg: SpotifyConfig,
  form: Record<string, string>,
  previousRefresh?: string,
): Promise<TokenSet> {
  const now = cfg.now ?? Date.now;
  let res: Response;
  try {
    res = await (cfg.fetch ?? fetch)(new URL("/api/token", cfg.accountsBase ?? ACCOUNTS_BASE), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
    });
  } catch {
    throw new SpotifyError("network", "Couldn't reach Spotify's sign-in service.");
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = typeof body?.error === "string" ? body.error : "";
    // invalid_grant: a used or expired code, or a refresh token the user revoked.
    if (code === "invalid_grant")
      throw new SpotifyError("not_connected", "Spotify needs you to sign in again.", {
        status: res.status,
      });
    if (code === "invalid_client")
      throw new SpotifyError(
        "not_configured",
        "Spotify rejected the Client ID. Check SPOTIFY_CLIENT_ID and the app's redirect URI.",
        { status: res.status },
      );
    throw new SpotifyError("spotify_error", `Spotify's token service answered ${res.status}.`, {
      status: res.status,
    });
  }
  const access = body?.access_token;
  const refresh = body?.refresh_token ?? previousRefresh;
  const expires = body?.expires_in;
  if (typeof access !== "string" || typeof refresh !== "string" || typeof expires !== "number")
    throw new SpotifyError("spotify_error", "Spotify's token service sent an unexpected answer.");
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: now() + expires * 1000,
    scope: typeof body?.scope === "string" ? body.scope : "",
  };
}
