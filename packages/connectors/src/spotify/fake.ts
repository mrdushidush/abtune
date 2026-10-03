// A stand-in for Spotify's accounts service and the few Web API endpoints ABTune calls, for tests
// and for driving the UI without a real Spotify app. `handle` is a fetch-style handler, so it can
// be passed as `fetch` or served over HTTP.
import { createHash, randomBytes } from "node:crypto";

export interface FakeTrack {
  readonly id: string;
  readonly name: string;
  readonly artists: readonly string[];
  readonly isrc?: string;
}

export interface FakeUser {
  readonly id: string;
  readonly display_name: string;
}

export interface FakePlaylist {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly description: string;
  readonly public: boolean;
  readonly items: string[];
}

/** A scripted failure: the next request whose path matches gets this response instead. */
export interface FakeFailure {
  readonly path: RegExp;
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** How many requests it applies to (default 1). */
  times?: number;
}

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: unknown;
}

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export class FakeSpotify {
  readonly clientId: string;
  readonly tracks: FakeTrack[];
  /** Who signs in at /authorize. */
  user: FakeUser = { id: "fakeuser", display_name: "Fake Listener" };
  /** Users allowed to call the API (the dev-mode allowlist); null = everyone. */
  allowlist: Set<string> | null = null;
  /** Seconds an access token lives. */
  expiresIn = 3600;
  readonly playlists = new Map<string, FakePlaylist>();
  readonly requests: FakeRequest[] = [];
  readonly failures: FakeFailure[] = [];
  private readonly codes = new Map<
    string,
    { challenge: string; redirectUri: string; user: FakeUser }
  >();
  private readonly access = new Map<string, { user: FakeUser; expires: number }>();
  private readonly refresh = new Map<string, FakeUser>();

  constructor(tracks: readonly FakeTrack[], clientId = "0123456789abcdef0123456789abcdef") {
    this.tracks = [...tracks];
    this.clientId = clientId;
  }

  /** As `fetch`. */
  readonly fetch = (input: string | URL | Request, init?: RequestInit) =>
    this.handle(new Request(input, init));

  readonly handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/v1(?=\/)/, "");
    const text = req.method === "GET" ? "" : await req.text();
    let body: unknown = text;
    if (req.headers.get("content-type")?.includes("application/json") && text)
      body = JSON.parse(text);
    else if (text) body = Object.fromEntries(new URLSearchParams(text));
    this.requests.push({
      method: req.method,
      path,
      query: Object.fromEntries(url.searchParams),
      body,
    });

    const fail = this.failures.find((f) => f.path.test(path));
    if (fail) {
      fail.times = (fail.times ?? 1) - 1;
      if (fail.times <= 0) this.failures.splice(this.failures.indexOf(fail), 1);
      return json(fail.status, fail.body, fail.headers);
    }

    if (path === "/authorize") return this.authorize(url);
    if (path === "/api/token") return this.token(body as Record<string, string>);

    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const session = this.access.get(token);
    if (!session || session.expires < Date.now())
      return json(401, { error: { status: 401, message: "The access token expired" } });
    if (this.allowlist && !this.allowlist.has(session.user.id))
      return json(403, {
        error: {
          status: 403,
          message:
            "Check settings on developer.spotify.com/dashboard, the user may not be registered.",
        },
      });
    const user = session.user;

    if (req.method === "GET" && path === "/me")
      return json(200, { id: user.id, display_name: user.display_name });
    if (req.method === "GET" && path === "/search") return this.search(url.searchParams);
    if (req.method === "POST" && path === "/me/playlists") {
      const b = body as { name?: string; description?: string; public?: boolean };
      if (!b.name) return json(400, { error: { status: 400, message: "Missing name" } });
      const id = randomBytes(11).toString("base64url");
      this.playlists.set(id, {
        id,
        owner: user.id,
        name: b.name,
        description: b.description ?? "",
        public: b.public ?? true,
        items: [],
      });
      return json(201, {
        id,
        uri: `spotify:playlist:${id}`,
        name: b.name,
        public: b.public ?? true,
        external_urls: { spotify: `https://open.spotify.com/playlist/${id}` },
      });
    }
    const add = /^\/playlists\/([^/]+)\/items$/.exec(path);
    if (req.method === "POST" && add) {
      const p = this.playlists.get(decodeURIComponent(add[1] as string));
      if (!p || p.owner !== user.id)
        return json(404, { error: { status: 404, message: "Not found" } });
      const uris = (body as { uris?: string[] }).uris ?? [];
      if (uris.length > 100)
        return json(400, { error: { status: 400, message: "Too many items" } });
      p.items.push(...uris);
      return json(201, { snapshot_id: randomBytes(8).toString("hex") });
    }
    return json(404, { error: { status: 404, message: "Service not found" } });
  };

  /** Make every access token expired (the next API call gets 401). */
  expireTokens(): void {
    for (const s of this.access.values()) s.expires = 0;
  }

  /** As if the user removed the app's access at spotify.com: refresh tokens stop working. */
  revoke(): void {
    this.refresh.clear();
    this.access.clear();
  }

  private authorize(url: URL): Response {
    const p = url.searchParams;
    const redirect = p.get("redirect_uri") ?? "";
    if (p.get("client_id") !== this.clientId || p.get("code_challenge_method") !== "S256")
      return json(400, { error: "invalid_client" });
    const back = new URL(redirect);
    const state = p.get("state");
    if (state) back.searchParams.set("state", state);
    const code = randomBytes(16).toString("base64url");
    this.codes.set(code, {
      challenge: p.get("code_challenge") ?? "",
      redirectUri: redirect,
      user: this.user,
    });
    back.searchParams.set("code", code);
    return new Response(null, { status: 302, headers: { location: back.toString() } });
  }

  private token(form: Record<string, string>): Response {
    if (form.client_id !== this.clientId) return json(400, { error: "invalid_client" });
    let user: FakeUser | undefined;
    if (form.grant_type === "authorization_code") {
      const code = this.codes.get(form.code ?? "");
      this.codes.delete(form.code ?? "");
      const challenge = createHash("sha256")
        .update(form.code_verifier ?? "")
        .digest("base64url");
      if (!code || code.challenge !== challenge || code.redirectUri !== form.redirect_uri)
        return json(400, { error: "invalid_grant" });
      user = code.user;
    } else if (form.grant_type === "refresh_token") {
      user = this.refresh.get(form.refresh_token ?? "");
      if (!user) return json(400, { error: "invalid_grant" });
    } else return json(400, { error: "unsupported_grant_type" });
    const access = randomBytes(16).toString("hex");
    this.access.set(access, { user, expires: Date.now() + this.expiresIn * 1000 });
    const out: Record<string, unknown> = {
      access_token: access,
      token_type: "Bearer",
      expires_in: this.expiresIn,
      scope: "playlist-modify-private playlist-modify-public",
    };
    if (form.grant_type === "authorization_code") {
      const refresh = randomBytes(16).toString("hex");
      this.refresh.set(refresh, user);
      out.refresh_token = refresh;
    }
    return json(200, out);
  }

  private search(p: URLSearchParams): Response {
    const q = p.get("q") ?? "";
    const limit = Number(p.get("limit") ?? 5);
    if (!(limit >= 1 && limit <= 10))
      return json(400, { error: { status: 400, message: "Invalid limit" } });
    let hits: FakeTrack[];
    const isrc = /^isrc:(\S+)$/.exec(q);
    const fields = /^track:"([^"]*)" artist:"([^"]*)"$/.exec(q);
    if (isrc) hits = this.tracks.filter((t) => t.isrc === isrc[1]);
    else if (fields) {
      const [title, artist] = [norm(fields[1] as string), norm(fields[2] as string)];
      hits = this.tracks.filter(
        (t) => norm(t.name).includes(title) && t.artists.some((a) => norm(a).includes(artist)),
      );
    } else {
      const words = norm(q).split(" ");
      hits = this.tracks.filter((t) => {
        const hay = norm(`${t.name} ${t.artists.join(" ")}`);
        return words.every((w) => hay.includes(w));
      });
    }
    return json(200, {
      tracks: {
        items: hits.slice(0, limit).map((t) => ({
          id: t.id,
          uri: `spotify:track:${t.id}`,
          name: t.name,
          artists: t.artists.map((name) => ({ name })),
          duration_ms: 200_000,
        })),
      },
    });
  }
}
