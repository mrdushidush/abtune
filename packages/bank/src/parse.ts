import type { Bank, Dimensions, PackDef, Question } from "@abtune/engine";
import { type Document, isMap, isNode, isScalar, LineCounter, parseDocument, visit } from "yaml";
import { type BankFileData, bankFileSchema } from "./schema.ts";

export type Severity = "error" | "warning";

export interface Diagnostic {
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
}

export type YamlPath = readonly (string | number)[];

/** A parsed YAML file plus what's needed to point diagnostics at its lines. */
export interface ParsedFile {
  readonly file: string;
  readonly doc: Document;
  readonly lineCounter: LineCounter;
  /** Present only if the file is valid YAML and matches the schema. */
  readonly data?: BankFileData;
}

/** Where a merged question came from, for diagnostics. */
export interface QuestionSource {
  readonly parsed: ParsedFile;
  readonly index: number;
}

export interface MergedBank {
  readonly bank: Bank;
  /** Index-aligned with `bank.questions`. */
  readonly sources: readonly QuestionSource[];
  /** The file that defines `dimensions` (normally the seed). */
  readonly dimensionsFile: ParsedFile;
  /** Which file defines each pack. */
  readonly packSources: ReadonlyMap<string, ParsedFile>;
}

/** YAML 1.1 parsers (e.g. PyYAML) read these plain scalars as booleans. */
const YAML11_BOOLEAN = /^(?:y|n|yes|no|on|off)$/i;

/** 1-based line/column of the node at `path`, or of its nearest existing ancestor. */
export function locate(parsed: ParsedFile, path: YamlPath): { line: number; col: number } {
  for (let n = path.length; n >= 0; n--) {
    const node = n === 0 ? parsed.doc.contents : parsed.doc.getIn(path.slice(0, n), true);
    if (isNode(node) && node.range) {
      return parsed.lineCounter.linePos(node.range[0]);
    }
  }
  return { line: 1, col: 1 };
}

/** Position of a map key (rather than its value), falling back to the map itself. */
export function locateKey(
  parsed: ParsedFile,
  mapPath: YamlPath,
  key: string,
): { line: number; col: number } {
  const map = parsed.doc.getIn(mapPath, true);
  if (isMap(map)) {
    for (const pair of map.items) {
      if (isScalar(pair.key) && pair.key.value === key && pair.key.range) {
        return parsed.lineCounter.linePos(pair.key.range[0]);
      }
    }
  }
  return locate(parsed, mapPath);
}

export function diagnostic(
  parsed: ParsedFile,
  pos: { line: number; col: number },
  rule: string,
  message: string,
  severity: Severity = "error",
): Diagnostic {
  return { file: parsed.file, line: pos.line, col: pos.col, rule, severity, message };
}

/** Parse one bank YAML file. Pure: takes text, never touches the filesystem. */
export function parseBankFile(
  text: string,
  file: string,
): { parsed: ParsedFile; diagnostics: Diagnostic[] } {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false,
    lineCounter,
  });
  const base: ParsedFile = { file, doc, lineCounter };
  const diagnostics: Diagnostic[] = [];

  for (const err of [...doc.errors, ...doc.warnings]) {
    const pos = lineCounter.linePos(err.pos[0]);
    const severity = doc.errors.includes(err as never) ? "error" : "warning";
    diagnostics.push(
      diagnostic(base, pos, "yaml-syntax", err.message.split("\n")[0] ?? "", severity),
    );
  }

  visit(doc, {
    Scalar(_key, node) {
      if (
        node.type === "PLAIN" &&
        typeof node.value === "string" &&
        YAML11_BOOLEAN.test(node.value)
      ) {
        const pos = node.range ? lineCounter.linePos(node.range[0]) : { line: 1, col: 1 };
        diagnostics.push(
          diagnostic(
            base,
            pos,
            "yaml-boolean",
            `Unquoted "${node.value}" is a boolean to YAML 1.1 parsers like PyYAML. Use true/false, or quote it if you mean the text.`,
          ),
        );
      }
    },
  });

  if (doc.errors.length > 0) return { parsed: base, diagnostics };

  const result = bankFileSchema.safeParse(doc.toJS());
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.filter((p): p is string | number => typeof p !== "symbol");
      const pos =
        issue.code === "unrecognized_keys" && issue.keys[0] !== undefined
          ? locateKey(base, path, issue.keys[0])
          : locate(base, path);
      const where = path.length > 0 ? `${path.join(".")}: ` : "";
      diagnostics.push(diagnostic(base, pos, "schema", `${where}${issue.message}`));
    }
    return { parsed: base, diagnostics };
  }
  return { parsed: { ...base, data: result.data }, diagnostics };
}

/**
 * Merge parsed files into one bank. Exactly one file must define `dimensions`; pack names
 * and question ids must be unique across files (duplicate ids are reported by lint).
 */
export function mergeBankFiles(files: readonly ParsedFile[]): {
  merged?: MergedBank;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const valid = files.filter((f) => f.data !== undefined);
  if (valid.length !== files.length) return { diagnostics };

  const withDims = valid.filter((f) => f.data?.dimensions !== undefined);
  if (withDims.length !== 1) {
    const target = withDims[1] ?? valid[0];
    if (target) {
      const message =
        withDims.length === 0
          ? "No file defines `dimensions`. Lint community packs together with data/questions/seed.yaml."
          : `\`dimensions\` is defined in more than one file (also in ${withDims[0]?.file}).`;
      diagnostics.push(diagnostic(target, locate(target, ["dimensions"]), "dimensions", message));
    }
    return { diagnostics };
  }
  const dimensionsFile = withDims[0] as ParsedFile;
  const dimensions = dimensionsFile.data?.dimensions as Dimensions;

  const packs: Record<string, PackDef> = {};
  const packSources = new Map<string, ParsedFile>();
  const questions: Question[] = [];
  const sources: QuestionSource[] = [];

  // The seed (dimensions file) goes first so community packs are the ones flagged for
  // duplicates, and the merged question order is stable: seed, then packs by path.
  const ordered = [dimensionsFile, ...valid.filter((f) => f !== dimensionsFile)];
  for (const parsed of ordered) {
    const data = parsed.data as BankFileData;
    for (const [name, def] of Object.entries(data.packs ?? {})) {
      const owner = packSources.get(name)?.file;
      if (owner !== undefined) {
        diagnostics.push(
          diagnostic(
            parsed,
            locateKey(parsed, ["packs"], name),
            "pack-duplicate",
            `Pack "${name}" is already defined in ${owner}.`,
          ),
        );
        continue;
      }
      packSources.set(name, parsed);
      packs[name] = def;
    }
    (data.questions ?? []).forEach((q, index) => {
      questions.push({ ...q, weight: q.weight ?? 1 });
      sources.push({ parsed, index });
    });
  }

  const bank: Bank = { version: 1, dimensions, packs, questions };
  return { merged: { bank, sources, dimensionsFile, packSources }, diagnostics };
}
