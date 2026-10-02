// Eval personas (HANDOFF §17): what a listener wants, in the bank's own dimensions.
import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import type { Dimensions } from "@abtune/engine";
import { parse } from "yaml";
import { z } from "zod";

const weight = z.number().gt(0).max(1);
const weights = z.record(z.string(), weight);
const range = z
  .tuple([z.number().min(-1).max(1), z.number().min(-1).max(1)])
  .refine(([lo, hi]) => lo <= hi, "range must be [lo, hi] with lo ≤ hi");

export const personaSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1),
  /** Target clusters with how much each counts (partial credit below 1). */
  clusters: weights,
  /** Target decades; omit for "any era". */
  decades: weights.optional(),
  /** Target languages (`none` = instrumental); omit for "any language". */
  languages: weights.optional(),
  /** Scalar ranges in the catalog's [-1, 1] scale; dims left out don't matter. */
  scalars: z.record(z.string(), range).default({}),
});

export type Persona = z.infer<typeof personaSchema>;

export const PERSONAS_DIR = "data/personas";

/** Throws unless every key the persona names exists in `dims`. */
export function checkPersona(persona: Persona, dims: Dimensions): void {
  const bad: string[] = [];
  const check = (keys: readonly string[], allowed: readonly string[], what: string) => {
    for (const k of keys) if (!allowed.includes(k)) bad.push(`${what} "${k}"`);
  };
  check(Object.keys(persona.clusters), dims.genres, "cluster");
  check(Object.keys(persona.decades ?? {}), dims.decades, "decade");
  check(Object.keys(persona.languages ?? {}), [...dims.languages, "none"], "language");
  check(Object.keys(persona.scalars), dims.scalar, "scalar");
  if (Object.keys(persona.clusters).length === 0) bad.push("no clusters");
  if (bad.length > 0) throw new Error(`persona ${persona.id}: unknown ${bad.join(", ")}`);
}

/** Load and check `<dir>/*.yaml`, sorted by file name; ids must be unique. */
export async function loadPersonas(dir: string, dims: Dimensions): Promise<Persona[]> {
  const files: string[] = [];
  for await (const f of glob("*.yaml", { cwd: dir })) files.push(f);
  files.sort();
  const personas: Persona[] = [];
  for (const f of files) {
    const data = parse(await readFile(path.join(dir, f), "utf8"), { uniqueKeys: true });
    const result = personaSchema.safeParse(data);
    if (!result.success) throw new Error(`${f}: ${z.prettifyError(result.error)}`);
    checkPersona(result.data, dims);
    if (personas.some((p) => p.id === result.data.id)) throw new Error(`${f}: duplicate id`);
    personas.push(result.data);
  }
  return personas;
}
