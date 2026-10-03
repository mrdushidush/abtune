// Spotify connections at rest (HANDOFF §11.1, §13): one JSON file, every entry AES-256-GCM
// encrypted with a key derived from TOKEN_ENCRYPTION_KEY. The web app writes it after sign-in;
// the MCP server reads it to push. Entries are keyed by a hash of the browser's connection cookie,
// so the file holds neither tokens nor cookie values in the clear.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { refreshTokens, type SpotifyConfig, type TokenSet } from "./auth.ts";
import type { TokenSource } from "./client.ts";
import { SpotifyError } from "./errors.ts";

export interface Connection extends TokenSet {
  readonly user_id: string;
  readonly display_name: string | null;
  /** Epoch ms. */
  readonly connected_at: number;
}

interface Sealed {
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

interface StoreFile {
  readonly version: 1;
  readonly connections: Record<string, Sealed>;
}

/** TOKEN_ENCRYPTION_KEY's minimum length (the .env.example command makes 43 characters). */
export const MIN_SECRET_LENGTH = 32;

export function deriveKey(secret: string): Buffer {
  if (secret.length < MIN_SECRET_LENGTH)
    throw new SpotifyError(
      "not_configured",
      `TOKEN_ENCRYPTION_KEY must be at least ${MIN_SECRET_LENGTH} characters.`,
    );
  return Buffer.from(hkdfSync("sha256", secret, "abtune", "spotify-tokens/v1", 32));
}

/** A browser's connection id: the cookie value (256 random bits). */
export const newConnectionId = () => randomBytes(32).toString("base64url");

/** Where a connection id's entry lives in the file. */
export const entryKey = (connectionId: string) =>
  createHash("sha256").update(`abtune-spotify:${connectionId}`).digest("base64url");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TokenStore {
  readonly file: string;
  private readonly key: Buffer;
  /** Read-modify-write cycles of this process, one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string, secret: string) {
    this.file = file;
    this.key = deriveKey(secret);
  }

  async read(entry: string): Promise<Connection | null> {
    const sealed = (await this.load()).connections[entry];
    return sealed ? this.open(entry, sealed) : null;
  }

  /** Every connection this key can open, most recently connected first. */
  async all(): Promise<{ entry: string; connection: Connection }[]> {
    const file = await this.load();
    const out: { entry: string; connection: Connection }[] = [];
    for (const [entry, sealed] of Object.entries(file.connections)) {
      const connection = this.open(entry, sealed);
      if (connection) out.push({ entry, connection });
    }
    return out.sort((a, b) => b.connection.connected_at - a.connection.connected_at);
  }

  write(entry: string, c: Connection): Promise<void> {
    return this.update((all) => {
      all[entry] = this.seal(entry, c);
    });
  }

  remove(entry: string): Promise<void> {
    return this.update((all) => {
      delete all[entry];
    });
  }

  private update(change: (all: Record<string, Sealed>) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const all = { ...(await this.load()).connections };
      change(all);
      await this.save({ version: 1, connections: all });
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async load(): Promise<StoreFile> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, connections: {} };
      throw err;
    }
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    return { version: 1, connections: parsed.connections ?? {} };
  }

  /** Write a temp file and rename it over the old one, so a reader never sees half a file. */
  private async save(file: StoreFile): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, this.file);
        return;
      } catch (err) {
        // Windows refuses to replace a file another process has open for a moment.
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
          await rm(tmp, { force: true });
          throw err;
        }
        await sleep(50 * (attempt + 1));
      }
    }
  }

  private seal(entry: string, c: Connection): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(entry));
    const data = Buffer.concat([cipher.update(JSON.stringify(c), "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      data: data.toString("base64url"),
    };
  }

  /** Null when the entry doesn't open with this key (TOKEN_ENCRYPTION_KEY changed) or is damaged. */
  private open(entry: string, s: Sealed): Connection | null {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(s.iv, "base64url"));
      decipher.setAAD(Buffer.from(entry));
      decipher.setAuthTag(Buffer.from(s.tag, "base64url"));
      const text = Buffer.concat([
        decipher.update(Buffer.from(s.data, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(text) as Connection;
    } catch {
      return null;
    }
  }
}

/** Refresh a minute early, so a token doesn't expire between the check and the call. */
const EARLY_MS = 60_000;

/** A stored connection's tokens, refreshed on demand and written back. */
export class StoredTokens implements TokenSource {
  private conn: Connection;
  private readonly cfg: SpotifyConfig;
  private readonly store: TokenStore;
  private readonly entry: string;
  private inflight: Promise<string> | null = null;

  constructor(cfg: SpotifyConfig, store: TokenStore, entry: string, conn: Connection) {
    this.cfg = cfg;
    this.store = store;
    this.entry = entry;
    this.conn = conn;
  }

  get connection(): Connection {
    return this.conn;
  }

  access(): Promise<string> {
    const now = (this.cfg.now ?? Date.now)();
    return this.conn.expires_at - EARLY_MS > now
      ? Promise.resolve(this.conn.access_token)
      : this.refresh();
  }

  refresh(): Promise<string> {
    this.inflight ??= (async () => {
      try {
        const tokens = await refreshTokens(this.cfg, this.conn.refresh_token);
        this.conn = { ...this.conn, ...tokens };
        await this.store.write(this.entry, this.conn);
        return this.conn.access_token;
      } catch (err) {
        // Revoked at spotify.com: forget it, so the UI offers to connect again.
        if (err instanceof SpotifyError && err.kind === "not_connected")
          await this.store.remove(this.entry);
        throw err;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
