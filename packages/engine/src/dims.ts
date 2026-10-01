import type { Bank, Dimensions, Question } from "./types.ts";

/** Categorical dimension groups. Each is a distribution; scalars are positions on an axis. */
export type GroupName = "decades" | "genres" | "languages";
export const GROUPS: readonly GroupName[] = ["decades", "genres", "languages"];

export type DimKind =
  | { readonly kind: "scalar"; readonly index: number }
  | { readonly kind: "group"; readonly group: GroupName; readonly index: number };

export interface DimRegistry {
  readonly scalar: readonly string[];
  readonly groups: Readonly<Record<GroupName, readonly string[]>>;
  readonly lookup: ReadonlyMap<string, DimKind>;
}

export function dimRegistry(dims: Dimensions): DimRegistry {
  const lookup = new Map<string, DimKind>();
  dims.scalar.forEach((key, index) => {
    lookup.set(key, { kind: "scalar", index });
  });
  for (const group of GROUPS) {
    dims[group].forEach((key, index) => {
      lookup.set(key, { kind: "group", group, index });
    });
  }
  return {
    scalar: dims.scalar,
    groups: { decades: dims.decades, genres: dims.genres, languages: dims.languages },
    lookup,
  };
}

/** Classify an fx key. Banks are linted, so an unknown key is a programming error. */
export function dimOf(registry: DimRegistry, key: string): DimKind {
  const kind = registry.lookup.get(key);
  if (!kind) throw new Error(`Unknown dimension "${key}"; was the bank linted?`);
  return kind;
}

/** One fx key a question touches: its dimension and |fx_a[k] − fx_b[k]| (missing = 0). */
export interface KeyDiff {
  readonly key: string;
  readonly dim: DimKind;
  readonly diff: number;
}

/** Per-bank lookups, memoized by object identity (banks are immutable once loaded). */
export interface BankIndex {
  readonly registry: DimRegistry;
  readonly byId: ReadonlyMap<string, Question>;
  /** Union of a/b fx keys per question, in a-then-b order (fixed float summation order). */
  readonly keyDiffs: ReadonlyMap<string, readonly KeyDiff[]>;
}

function questionKeyDiffs(registry: DimRegistry, q: Question): KeyDiff[] {
  const out: KeyDiff[] = [];
  const seen = new Set<string>();
  for (const key of [...Object.keys(q.a.fx), ...Object.keys(q.b.fx)]) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      dim: dimOf(registry, key),
      diff: Math.abs((q.a.fx[key] ?? 0) - (q.b.fx[key] ?? 0)),
    });
  }
  return out;
}

const indexCache = new WeakMap<Bank, BankIndex>();

export function bankIndex(bank: Bank): BankIndex {
  let index = indexCache.get(bank);
  if (!index) {
    const registry = dimRegistry(bank.dimensions);
    index = {
      registry,
      byId: new Map(bank.questions.map((q) => [q.id, q])),
      keyDiffs: new Map(bank.questions.map((q) => [q.id, questionKeyDiffs(registry, q)])),
    };
    indexCache.set(bank, index);
  }
  return index;
}
