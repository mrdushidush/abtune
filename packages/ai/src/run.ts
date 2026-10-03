import { canonicalJson, sha256Hex } from "@abtune/engine";
import type { Prompt } from "./prompts.ts";
import { AiCallError, type AiProvider } from "./provider.ts";

/**
 * One AI task (HANDOFF §10.2): how to ask, the JSON schema of the answer, and how to turn the answer
 * into a safe value. `parse` returns null for an answer that doesn't fit (it may also drop or clamp
 * parts of one that mostly does).
 */
export interface Task<I, O> {
  readonly name: string;
  readonly prompt: Prompt;
  /** The user message for this input. */
  user(input: I): string;
  schema(input: I): Readonly<Record<string, unknown>>;
  maxTokens(input: I): number;
  /** The call's time limit is the runtime's × this (default 1): for answers that grow with input. */
  timeoutFactor?(input: I): number;
  parse(answer: unknown, input: I): O | null;
}

export type AiFailure =
  /** No answer within the time limit (§10.4: 20 s local). */
  | "timeout"
  /** The model server is down, refused the request, or answered an HTTP error. */
  | "unreachable"
  /** The answer wasn't valid JSON for the schema, twice. */
  | "invalid"
  /** The answer was larger than any valid one. */
  | "oversized";

export type AiResult<O> =
  | { readonly ok: true; readonly value: O; readonly cached: boolean }
  | { readonly ok: false; readonly failure: AiFailure };

/** Bounded in-memory cache. Answers derived from quiz answers never go to disk (HANDOFF §13). */
export class AiCache {
  private readonly map = new Map<string, unknown>();
  readonly max: number;
  constructor(max = 500) {
    this.max = max;
  }
  get(key: string): unknown {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: unknown): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }
  get size(): number {
    return this.map.size;
  }
  /** Every entry, least recently used first. */
  entries(): IterableIterator<[string, unknown]> {
    return this.map.entries();
  }
}

export interface AiRuntime {
  readonly provider: AiProvider;
  readonly timeoutMs: number;
  readonly cache: AiCache;
  /** Failures, by kind only: never a prompt or an answer (HANDOFF §13). */
  readonly log?: (line: string) => void;
}

/** Appended to the user message on the one retry, so a deterministic server can answer differently. */
export const RETRY_NOTE =
  "\n\nYour previous answer was not valid JSON for the required schema. Answer again with JSON only.";

/** sha256 over (provider, model, task, prompt version, messages, schema) (§10.4). */
export function cacheKey(
  provider: AiProvider,
  task: Task<unknown, unknown>,
  user: string,
  schema: unknown,
): string {
  return sha256Hex(
    canonicalJson([
      provider.id,
      provider.model,
      task.name,
      task.prompt.version,
      task.prompt.system,
      user,
      schema,
    ]),
  );
}

/** A model's text → JSON. Tolerates a ```json fence around it; nothing else. */
export function parseJsonAnswer(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return JSON.parse(fenced ? (fenced[1] as string) : t);
}

const inflight = new Map<string, Promise<AiResult<unknown>>>();

/**
 * The guardrails of §10.4: cached by input hash, a time limit per call, schema-validated, one retry
 * on an invalid answer, then a failure the caller turns into the classic engine plus a notice.
 */
export async function runTask<I, O>(
  rt: AiRuntime,
  task: Task<I, O>,
  input: I,
  signal?: AbortSignal,
): Promise<AiResult<O>> {
  const user = task.user(input);
  const schema = task.schema(input);
  const key = cacheKey(rt.provider, task as Task<unknown, unknown>, user, schema);
  const hit = rt.cache.get(key);
  if (hit !== undefined) return { ok: true, value: hit as O, cached: true };
  const pending = inflight.get(key);
  if (pending) return (await pending) as AiResult<O>;
  const run = (async (): Promise<AiResult<O>> => {
    const limit = rt.timeoutMs * Math.max(1, task.timeoutFactor?.(input) ?? 1);
    for (let attempt = 0; attempt < 2; attempt++) {
      const timeout = AbortSignal.timeout(limit);
      let text: string;
      try {
        text = await rt.provider.complete({
          task: task.name,
          system: task.prompt.system,
          user: attempt === 0 ? user : user + RETRY_NOTE,
          schema,
          maxTokens: task.maxTokens(input),
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
      } catch (err) {
        const failure: AiFailure =
          err instanceof AiCallError
            ? err.kind === "timeout"
              ? "timeout"
              : err.kind === "oversized"
                ? "oversized"
                : err.kind === "empty"
                  ? "invalid"
                  : "unreachable"
            : "unreachable";
        if (failure === "invalid" && attempt === 0) continue;
        rt.log?.(`AI ${task.name}: ${failure}`);
        return { ok: false, failure };
      }
      let value: O | null = null;
      try {
        value = task.parse(parseJsonAnswer(text), input);
      } catch {
        value = null;
      }
      if (value !== null) {
        rt.cache.set(key, value);
        return { ok: true, value, cached: false };
      }
    }
    rt.log?.(`AI ${task.name}: invalid`);
    return { ok: false, failure: "invalid" };
  })();
  inflight.set(key, run as Promise<AiResult<unknown>>);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}
