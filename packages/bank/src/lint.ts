import type { Question } from "@abtune/engine";
import { type Diagnostic, diagnostic, locate, locateKey, type MergedBank } from "./parse.ts";

export interface LintOptions {
  /** Each scalar dim must be touched by at least this many core/context questions. */
  readonly scalarCoverage?: number;
  /** Each genre cluster must be touched by at least this many questions (any pack). */
  readonly genreCoverage?: number;
  /** Max label length in code points, so labels fit mobile cards. */
  readonly maxLabelLength?: number;
  /** Max |v| for any fx value of a `sensitive` question. */
  readonly sensitiveMaxEffect?: number;
}

const DEFAULTS: Required<LintOptions> = {
  scalarCoverage: 5,
  genreCoverage: 3,
  maxLabelLength: 22,
  sensitiveMaxEffect: 0.4,
};

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;
const UNLOCK_REF = /^([a-z][a-z0-9_]*)=(a|b)$/;
const COVERAGE_PACKS = new Set(["core", "context"]);

/** Authoring rules from HANDOFF §8.4, applied to a merged bank. */
export function lintBank(merged: MergedBank, options: LintOptions = {}): Diagnostic[] {
  const opts = { ...DEFAULTS, ...options };
  const { bank, sources, dimensionsFile } = merged;
  const dims = bank.dimensions;
  const scalars = new Set(dims.scalar);
  const genres = new Set(dims.genres);
  const allKeys = new Set([...dims.scalar, ...dims.decades, ...dims.genres, ...dims.languages]);
  const out: Diagnostic[] = [];

  // Dimension keys: snake_case and unique across all groups.
  const seenDim = new Set<string>();
  for (const group of ["scalar", "decades", "genres", "languages"] as const) {
    dims[group].forEach((key, i) => {
      const pos = locate(dimensionsFile, ["dimensions", group, i]);
      if (!SNAKE_CASE.test(key)) {
        out.push(
          diagnostic(
            dimensionsFile,
            pos,
            "dimension-key",
            `Dimension "${key}" must be snake_case.`,
          ),
        );
      }
      if (seenDim.has(key)) {
        out.push(
          diagnostic(dimensionsFile, pos, "dimension-key", `Dimension "${key}" is listed twice.`),
        );
      }
      seenDim.add(key);
    });
  }

  const ids = new Set(bank.questions.map((q) => q.id));
  const byId = new Map(bank.questions.map((q) => [q.id, q]));
  const seenIds = new Map<string, string>();

  bank.questions.forEach((q, qi) => {
    const src = sources[qi];
    if (!src) return;
    const { parsed, index } = src;
    const at = (...path: (string | number)[]) => locate(parsed, ["questions", index, ...path]);
    const report = (pos: { line: number; col: number }, rule: string, message: string) =>
      out.push(diagnostic(parsed, pos, rule, `${q.id}: ${message}`));

    if (!SNAKE_CASE.test(q.id)) report(at("id"), "id-format", "id must be snake_case.");
    const firstFile = seenIds.get(q.id);
    if (firstFile !== undefined) {
      report(
        at("id"),
        "id-unique",
        `duplicate id (first defined in ${firstFile}). Ids are stable forever.`,
      );
    } else {
      seenIds.set(q.id, parsed.file);
    }

    if (!(q.pack in bank.packs)) {
      report(at("pack"), "pack-unknown", `pack "${q.pack}" is not defined under \`packs\`.`);
    }

    for (const side of ["a", "b"] as const) {
      const option = q[side];
      const length = [...option.label].length;
      if (length > opts.maxLabelLength) {
        report(
          at(side, "label"),
          "label-length",
          `${side}.label is ${length} chars; keep it to ${opts.maxLabelLength} so it fits a phone card.`,
        );
      }
      const entries = Object.entries(option.fx);
      if (entries.length === 0) report(at(side, "fx"), "fx-empty", `${side}.fx has no effects.`);
      for (const [key, value] of entries) {
        const keyPos = locateKey(parsed, ["questions", index, side, "fx"], key);
        if (!allKeys.has(key)) {
          report(keyPos, "fx-unknown-key", `${side}.fx key "${key}" is not a dimension.`);
        }
        if (!Number.isFinite(value) || value < -1 || value > 1) {
          report(
            at(side, "fx", key),
            "fx-range",
            `${side}.fx.${key} = ${value} is outside [-1, 1].`,
          );
        }
        if (q.sensitive !== undefined) {
          if (!scalars.has(key)) {
            report(
              keyPos,
              "sensitive-fx",
              `sensitive questions may only touch scalar dims; "${key}" is not one. Identity choices never map to genre or language.`,
            );
          } else if (Math.abs(value) > opts.sensitiveMaxEffect) {
            report(
              at(side, "fx", key),
              "sensitive-fx",
              `sensitive questions are capped at |v| <= ${opts.sensitiveMaxEffect}; ${side}.fx.${key} = ${value}.`,
            );
          }
        }
      }
    }

    q.unlock_if?.any?.forEach((ref, i) => {
      const match = UNLOCK_REF.exec(ref);
      if (!match) {
        report(
          at("unlock_if", "any", i),
          "unlock-ref",
          `unlock_if.any "${ref}" must look like "question_id=a" or "=b".`,
        );
      } else if (!ids.has(match[1] as string)) {
        report(
          at("unlock_if", "any", i),
          "unlock-ref",
          `unlock_if.any refers to unknown question "${match[1]}".`,
        );
      } else if (match[1] === q.id) {
        report(
          at("unlock_if", "any", i),
          "unlock-ref",
          "unlock_if.any refers to the question itself.",
        );
      }
    });
    q.unlock_if?.top_genres?.forEach((g, i) => {
      if (!genres.has(g)) {
        report(
          at("unlock_if", "top_genres", i),
          "unlock-genre",
          `unlock_if.top_genres "${g}" is not a genre cluster.`,
        );
      }
    });
    if (q.unlock_if && !q.unlock_if.any && !q.unlock_if.top_genres) {
      report(at("unlock_if"), "unlock-ref", "unlock_if needs `any` and/or `top_genres`.");
    }

    // Families: a variant points at its canonical question and is asked in its place.
    if (q.family !== undefined) {
      const canonical = byId.get(q.family);
      if (!canonical) {
        report(at("family"), "family", `family "${q.family}" is not a question id.`);
      } else if (canonical.id === q.id) {
        report(
          at("family"),
          "family",
          "a canonical question has no `family`; only its variants do.",
        );
      } else if (canonical.family !== undefined) {
        report(
          at("family"),
          "family",
          `"${q.family}" is itself a variant (of "${canonical.family}"); point to the canonical question.`,
        );
      } else if (canonical.pack !== q.pack) {
        report(
          at("pack"),
          "family",
          `a variant shares its canonical question's pack ("${canonical.pack}").`,
        );
      }
      if (q.unlock_if) {
        report(
          at("unlock_if"),
          "family",
          "variants unlock with their canonical question; remove unlock_if.",
        );
      }
    }
  });

  // Coverage: every scalar touched by enough core/context questions, every genre by enough questions.
  const touches = (q: Question, key: string) => key in q.a.fx || key in q.b.fx;
  dims.scalar.forEach((key, i) => {
    const n = bank.questions.filter((q) => COVERAGE_PACKS.has(q.pack) && touches(q, key)).length;
    if (n < opts.scalarCoverage) {
      out.push(
        diagnostic(
          dimensionsFile,
          locate(dimensionsFile, ["dimensions", "scalar", i]),
          "coverage-scalar",
          `Scalar "${key}" is touched by ${n} core/context questions; needs at least ${opts.scalarCoverage}.`,
        ),
      );
    }
  });
  dims.genres.forEach((key, i) => {
    const n = bank.questions.filter((q) => touches(q, key)).length;
    if (n < opts.genreCoverage) {
      out.push(
        diagnostic(
          dimensionsFile,
          locate(dimensionsFile, ["dimensions", "genres", i]),
          "coverage-genre",
          `Genre "${key}" is touched by ${n} questions; needs at least ${opts.genreCoverage}.`,
        ),
      );
    }
  });

  // Packs.
  for (const [name, file] of merged.packSources) {
    if (!SNAKE_CASE.test(name)) {
      out.push(
        diagnostic(
          file,
          locateKey(file, ["packs"], name),
          "pack-name",
          `Pack "${name}" must be snake_case.`,
        ),
      );
    }
  }

  return out;
}
