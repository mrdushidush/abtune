import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Versioned prompt files (HANDOFF §10.5): `packages/ai/prompts/<name>.md`, front matter with
 * `version:`, then the system message, a line `=== user ===`, and the user message template with
 * `{{placeholders}}`. The version is part of the cache key; bump it whenever the wording changes.
 */
export interface Prompt {
  readonly name: string;
  readonly version: number;
  readonly system: string;
  readonly user: string;
}

export const PROMPTS_DIR = path.resolve(import.meta.dirname, "../prompts");

export function parsePrompt(name: string, raw: string): Prompt {
  // LF everywhere: the prompt is part of the cache key, whatever the checkout's line endings.
  const text = raw.replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`prompt ${name}: missing front matter`);
  const version = Number(/^version:\s*(\d+)\s*$/m.exec(m[1] as string)?.[1]);
  if (!Number.isInteger(version) || version < 1) throw new Error(`prompt ${name}: bad version`);
  const parts = (m[2] as string).split(/^=== user ===\s*$/m);
  if (parts.length !== 2) throw new Error(`prompt ${name}: needs one "=== user ===" line`);
  return {
    name,
    version,
    system: (parts[0] as string).trim(),
    user: (parts[1] as string).trim(),
  };
}

const cache = new Map<string, Prompt>();

export function loadPrompt(name: string, dir = PROMPTS_DIR): Prompt {
  const key = `${dir}\0${name}`;
  let p = cache.get(key);
  if (!p) {
    p = parsePrompt(name, readFileSync(path.join(dir, `${name}.md`), "utf8"));
    cache.set(key, p);
  }
  return p;
}

/** Fill `{{name}}` placeholders. Every placeholder must have a value, and every value a place. */
export function render(template: string, vars: Readonly<Record<string, string>>): string {
  const used = new Set<string>();
  const out = template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`prompt: no value for {{${k}}}`);
    used.add(k);
    return v;
  });
  for (const k of Object.keys(vars))
    if (!used.has(k)) throw new Error(`prompt: {{${k}}} isn't in the template`);
  return out;
}
