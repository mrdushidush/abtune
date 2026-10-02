// Minimal streaming tar reader/writer: ustar, PAX (path/size) and GNU long names, which is
// everything the MetaBrainz dumps and our dev-sample archive use. No dependency needed.

const BLOCK = 512;

/** Buffered pull reader over an async byte stream. */
class ByteReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private done = false;
  private readonly source: AsyncIterator<Uint8Array>;
  constructor(source: AsyncIterator<Uint8Array>) {
    this.source = source;
  }

  /** Buffer at least `n` bytes; false if the stream ends first. */
  async fill(n: number): Promise<boolean> {
    while (this.length < n && !this.done) {
      const r = await this.source.next();
      if (r.done) this.done = true;
      else if (r.value.length > 0) {
        const chunk = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value);
        this.chunks.push(chunk);
        this.length += chunk.length;
      }
    }
    return this.length >= n;
  }

  /** Take exactly `n` buffered bytes (call `fill(n)` first). */
  take(n: number): Buffer {
    const first = this.chunks[0];
    let out: Buffer;
    if (first && first.length >= n) {
      out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
    } else {
      const all = Buffer.concat(this.chunks);
      out = all.subarray(0, n);
      this.chunks = all.length > n ? [all.subarray(n)] : [];
    }
    this.length -= n;
    return out;
  }

  async read(n: number): Promise<Buffer> {
    if (!(await this.fill(n))) throw new Error("tar: unexpected end of archive");
    return this.take(n);
  }

  /** Yield exactly `n` bytes as they arrive, without concatenating. */
  async *stream(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.length === 0 && !(await this.fill(1)))
        throw new Error("tar: unexpected end of archive");
      const chunk = this.take(Math.min(left, this.chunks[0]?.length ?? left, this.length));
      left -= chunk.length;
      yield chunk;
    }
  }

  async skip(n: number): Promise<void> {
    for await (const _ of this.stream(n)) {
      // discard
    }
  }

  /** Stop reading: lets a consumer quit early without decompressing the rest. */
  async close(): Promise<void> {
    this.chunks = [];
    this.length = 0;
    if (!this.done) await this.source.return?.();
    this.done = true;
  }
}

export interface TarEntry {
  readonly name: string;
  readonly size: number;
  readonly type: "file" | "directory" | "other";
  /** Read the whole body (small files). */
  buffer(): Promise<Buffer>;
  /** Stream the body (large files). Unread bodies are skipped automatically. */
  stream(): AsyncIterable<Buffer>;
}

function cString(buf: Buffer, start: number, end: number): string {
  const slice = buf.subarray(start, end);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
}

/** Numeric header field: octal text, or GNU base-256 for values ≥ 8 GiB. */
function numeric(buf: Buffer, start: number, end: number): number {
  const first = buf[start] ?? 0;
  if (first & 0x80) {
    let value = first & 0x7f;
    for (let i = start + 1; i < end; i++) value = value * 256 + (buf[i] ?? 0);
    return value;
  }
  const text = cString(buf, start, end).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parsePax(body: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    if (space === -1) break;
    const len = Number.parseInt(body.subarray(pos, space).toString("utf8"), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = body.subarray(space + 1, pos + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    pos += len;
  }
  return out;
}

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;

/**
 * Iterate the entries of a tar stream. Each entry must be consumed (or ignored) before
 * advancing; ignored bodies are skipped.
 */
export async function* readTar(source: AsyncIterable<Uint8Array>): AsyncGenerator<TarEntry> {
  const reader = new ByteReader(source[Symbol.asyncIterator]());
  let paxPath: string | undefined;
  let paxSize: number | undefined;
  let longName: string | undefined;
  try {
    while (true) {
      if (!(await reader.fill(BLOCK))) return;
      const header = reader.take(BLOCK);
      if (header.every((b) => b === 0)) return; // end-of-archive marker
      const typeflag = String.fromCharCode(header[156] ?? 0);
      let size = numeric(header, 124, 136);

      if (typeflag === "x" || typeflag === "g" || typeflag === "L") {
        const body = await reader.read(size);
        await reader.skip(padding(size));
        if (typeflag === "x") {
          const pax = parsePax(body);
          paxPath = pax.get("path") ?? paxPath;
          const s = pax.get("size");
          if (s !== undefined) paxSize = Number(s);
        } else if (typeflag === "L") {
          longName = cString(body, 0, body.length);
        }
        continue;
      }

      let name = cString(header, 0, 100);
      if (cString(header, 257, 262) === "ustar") {
        const prefix = cString(header, 345, 500);
        if (prefix) name = `${prefix}/${name}`;
      }
      name = paxPath ?? longName ?? name;
      if (paxSize !== undefined) size = paxSize;
      paxPath = paxSize = longName = undefined;
      const type =
        typeflag === "0" || typeflag === "\0" || typeflag === "7"
          ? "file"
          : typeflag === "5"
            ? "directory"
            : "other";

      let claimed = false;
      let remaining = size;
      const claim = () => {
        if (claimed) throw new Error(`tar: body of ${name} already read`);
        claimed = true;
      };
      yield {
        name,
        size,
        type,
        async buffer() {
          claim();
          const body = await reader.read(size);
          remaining = 0;
          return body;
        },
        async *stream() {
          claim();
          for await (const chunk of reader.stream(size)) {
            remaining -= chunk.length;
            yield chunk;
          }
        },
      };
      // Skip whatever the consumer left unread (nothing, part of the body, or all of it).
      await reader.skip(remaining + padding(size));
    }
  } finally {
    await reader.close().catch(() => {});
  }
}

function writeOctal(buf: Buffer, value: number, start: number, length: number): void {
  buf.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length, "ascii");
}

/** One ustar header block for a regular file (names up to 100 bytes; mtime fixed for determinism). */
export function tarHeader(name: string, size: number, mtime = 0): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar: name too long: ${name}`);
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  writeOctal(h, 0o644, 100, 8);
  writeOctal(h, 0, 108, 8);
  writeOctal(h, 0, 116, 8);
  writeOctal(h, size, 124, 12);
  writeOctal(h, mtime, 136, 12);
  h.fill(0x20, 148, 156); // checksum field counts as spaces
  h.write("0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

/** Serialize files into tar blocks (deterministic: fixed mtime, given order). */
export function* writeTar(
  files: Iterable<{ name: string; data: Uint8Array }>,
): Generator<Uint8Array> {
  for (const f of files) {
    yield tarHeader(f.name, f.data.length);
    yield f.data;
    const pad = padding(f.data.length);
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(BLOCK * 2);
}
