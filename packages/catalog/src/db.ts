// DuckDB session for the catalog build: tuned for one big analytical job on a workstation.
import { availableParallelism, totalmem } from "node:os";
import { type DuckDBConnection, DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";

export interface DbOptions {
  /** e.g. "16GB". Defaults to half of physical RAM. */
  readonly memoryLimit?: string;
  readonly threads?: number;
  /** Spill directory for out-of-core joins and sorts. */
  readonly tempDir?: string;
}

export type Row = Record<string, DuckDBValue>;

export class Db {
  private readonly instance: DuckDBInstance;
  readonly conn: DuckDBConnection;

  private constructor(instance: DuckDBInstance, conn: DuckDBConnection) {
    this.instance = instance;
    this.conn = conn;
  }

  static async open(file: string, opts: DbOptions = {}): Promise<Db> {
    const memory = opts.memoryLimit ?? `${Math.max(1, Math.floor(totalmem() / 2 / 2 ** 30))}GB`;
    const config: Record<string, string> = {
      memory_limit: memory,
      threads: String(opts.threads ?? availableParallelism()),
      // Insertion order is irrelevant: every export sorts explicitly. Dropping it saves memory.
      preserve_insertion_order: "false",
    };
    if (opts.tempDir) config.temp_directory = opts.tempDir;
    const instance = await DuckDBInstance.create(file, config);
    return new Db(instance, await instance.connect());
  }

  /** Run one or more statements. */
  async run(sql: string): Promise<void> {
    await this.conn.run(sql);
  }

  /** Rows as plain objects (BIGINT/HUGEINT become JS numbers when safe, else strings). */
  async all<T = Row>(sql: string): Promise<T[]> {
    const reader = await this.conn.runAndReadAll(sql);
    return reader.getRowObjectsJS().map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = typeof v === "bigint" ? toNumber(v) : v;
      return out as T;
    });
  }

  async one<T = Row>(sql: string): Promise<T> {
    const rows = await this.all<T>(sql);
    if (rows.length !== 1)
      throw new Error(`expected one row, got ${rows.length}: ${sql.slice(0, 120)}`);
    return rows[0] as T;
  }

  async value<T = unknown>(sql: string): Promise<T> {
    const row = await this.one<Record<string, unknown>>(sql);
    return Object.values(row)[0] as T;
  }

  close(): void {
    this.conn.closeSync();
    this.instance.closeSync();
  }
}

function toNumber(v: bigint): number | string {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(v)
    : v.toString();
}

/** SQL string literal. */
export function lit(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/** A path as a SQL literal with forward slashes (DuckDB accepts them on Windows too). */
export function pathLit(p: string): string {
  return lit(p.replaceAll("\\", "/"));
}
