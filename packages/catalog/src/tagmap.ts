// data/tag_map.yaml: MusicBrainz tags → genre clusters and scalar nudges (HANDOFF §6.2.6).
import { readFile } from "node:fs/promises";
import type { Dimensions } from "@abtune/engine";
import { parse } from "yaml";
import { z } from "zod";

export const DEFAULT_TAG_MAP = "data/tag_map.yaml";

/** Scalar dims a tag may nudge (others come from AcousticBrainz or popularity). */
export const NUDGE_DIMS = ["complexity", "intensity"] as const;

const effects = z.record(z.string(), z.number());

const tagMapSchema = z.object({
  version: z.literal(1),
  tags: z.record(z.string(), effects),
  cluster_priors: z.record(z.string(), effects).default({}),
  non_music: z.array(z.string()).default([]),
  ab_genres: z.record(z.string(), effects).default({}),
});

export type TagMapFile = z.infer<typeof tagMapSchema>;

export interface TagMap {
  readonly file: TagMapFile;
  /** sha256 of the YAML text, recorded in the catalog manifest. */
  readonly text: string;
}

export interface TagMapIssue {
  readonly where: string;
  readonly message: string;
}

/** Validate a parsed tag map against the bank's dimensions. Empty list = valid. */
export function checkTagMap(
  file: TagMapFile,
  dims: Dimensions,
  minTagsPerCluster = 5,
): TagMapIssue[] {
  const issues: TagMapIssue[] = [];
  const clusters = new Set(dims.genres);
  const nudges = new Set<string>(NUDGE_DIMS);
  const perCluster = new Map<string, number>();
  const checkEffects = (where: string, fx: Record<string, number>, allowNudges: boolean) => {
    if (Object.keys(fx).length === 0) issues.push({ where, message: "no effects" });
    for (const [k, v] of Object.entries(fx)) {
      if (clusters.has(k)) {
        if (!(v > 0 && v <= 1))
          issues.push({ where, message: `${k}: cluster weight ${v} not in (0, 1]` });
        perCluster.set(k, (perCluster.get(k) ?? 0) + 1);
      } else if (allowNudges && nudges.has(k)) {
        if (!(v >= -1 && v <= 1))
          issues.push({ where, message: `${k}: nudge ${v} not in [-1, 1]` });
      } else {
        issues.push({
          where,
          message: `unknown key "${k}" (want a genre cluster${allowNudges ? " or complexity/intensity" : ""})`,
        });
      }
    }
  };
  for (const [tag, fx] of Object.entries(file.tags)) {
    if (tag !== tag.toLowerCase() || tag !== tag.trim())
      issues.push({ where: `tags.${tag}`, message: "tag must be lowercase and trimmed" });
    checkEffects(`tags.${tag}`, fx, true);
  }
  const counted = new Map(perCluster);
  for (const [cluster, fx] of Object.entries(file.cluster_priors)) {
    if (!clusters.has(cluster))
      issues.push({ where: `cluster_priors.${cluster}`, message: "unknown cluster" });
    for (const [k, v] of Object.entries(fx)) {
      if (!nudges.has(k))
        issues.push({ where: `cluster_priors.${cluster}`, message: `unknown scalar "${k}"` });
      else if (!(v >= -1 && v <= 1))
        issues.push({ where: `cluster_priors.${cluster}`, message: `${k}: ${v} not in [-1, 1]` });
    }
  }
  for (const [cls, fx] of Object.entries(file.ab_genres)) {
    if (!/^genre_(dortmund|rosamerica)__[a-z]+$/.test(cls))
      issues.push({ where: `ab_genres.${cls}`, message: "unknown classifier class" });
    checkEffects(`ab_genres.${cls}`, fx, false);
  }
  const seen = new Set<string>();
  for (const tag of file.non_music) {
    if (seen.has(tag)) issues.push({ where: `non_music`, message: `duplicate "${tag}"` });
    seen.add(tag);
    if (tag in file.tags)
      issues.push({ where: `non_music`, message: `"${tag}" is also mapped to clusters` });
  }
  for (const c of dims.genres) {
    const n = counted.get(c) ?? 0;
    if (n < minTagsPerCluster)
      issues.push({
        where: `tags`,
        message: `cluster ${c} has ${n} tags (want ≥ ${minTagsPerCluster})`,
      });
  }
  return issues;
}

export function parseTagMap(text: string): TagMapFile {
  return tagMapSchema.parse(parse(text, { uniqueKeys: true }));
}

export async function loadTagMap(file = DEFAULT_TAG_MAP, dims?: Dimensions): Promise<TagMap> {
  const text = await readFile(file, "utf8");
  const parsed = parseTagMap(text);
  if (dims) {
    const issues = checkTagMap(parsed, dims);
    if (issues.length > 0) {
      throw new Error(`${file}:\n${issues.map((i) => `  ${i.where}: ${i.message}`).join("\n")}`);
    }
  }
  return { file: parsed, text };
}

/** Long-format rows for DuckDB: (tag, key, value). */
export function tagMapRows(file: TagMapFile): {
  tags: [string, string, number][];
  priors: [string, string, number][];
  nonMusic: string[];
  abGenres: [string, string, number][];
} {
  const tags: [string, string, number][] = [];
  for (const [tag, fx] of Object.entries(file.tags))
    for (const [k, v] of Object.entries(fx)) tags.push([tag, k, v]);
  const priors: [string, string, number][] = [];
  for (const [c, fx] of Object.entries(file.cluster_priors))
    for (const [k, v] of Object.entries(fx)) priors.push([c, k, v]);
  const abGenres: [string, string, number][] = [];
  for (const [cls, fx] of Object.entries(file.ab_genres))
    for (const [k, v] of Object.entries(fx)) abGenres.push([cls, k, v]);
  return { tags, priors, nonMusic: [...file.non_music], abGenres };
}
