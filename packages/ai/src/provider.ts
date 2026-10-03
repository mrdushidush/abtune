import type { AiSettings } from "./config.ts";

/** One chat completion with schema-constrained JSON output (HANDOFF §10.1). */
export interface CompletionRequest {
  /** The task, e.g. "interpret": names the JSON schema. */
  readonly task: string;
  readonly system: string;
  readonly user: string;
  /** JSON schema the answer must follow (`response_format: json_schema`). */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
}

export interface AiProvider {
  /** Provider kind and endpoint (part of the cache key). */
  readonly id: string;
  readonly model: string;
  /** The model's raw text answer. Throws AiCallError. */
  complete(req: CompletionRequest): Promise<string>;
}

export type AiCallErrorKind = "timeout" | "unreachable" | "http" | "oversized" | "empty";

export class AiCallError extends Error {
  override name = "AiCallError";
  readonly kind: AiCallErrorKind;
  readonly status: number | undefined;
  constructor(kind: AiCallErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** Largest response body read from a model server; a bigger one is treated as oversized output. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** Read at most `max` bytes of a response body, or throw `oversized`. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new AiCallError("oversized", `response over ${max} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const isAbort = (err: unknown) =>
  err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");

/**
 * An OpenAI-compatible chat completions endpoint: LM Studio, Ollama, llama.cpp server, vLLM.
 * Temperature 0 and a fixed seed (§10.1), so the same prompt tends to give the same answer; the
 * cache makes it exact.
 */
export function openaiCompat(settings: AiSettings): AiProvider {
  const doFetch = settings.fetch ?? fetch;
  return {
    id: `openai_compat ${settings.baseUrl}`,
    model: settings.model,
    async complete(req) {
      const body = {
        model: settings.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        temperature: 0,
        seed: 42,
        max_tokens: req.maxTokens,
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: { name: req.task, strict: true, schema: req.schema },
        },
        ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
      };
      let res: Response;
      try {
        res = await doFetch(`${settings.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err) {
        if (isAbort(err) || req.signal.aborted) throw new AiCallError("timeout", "timed out");
        throw new AiCallError("unreachable", "can't reach the model server");
      }
      let text: string;
      try {
        text = await readCapped(res, MAX_RESPONSE_BYTES);
      } catch (err) {
        if (err instanceof AiCallError) throw err;
        if (isAbort(err) || req.signal.aborted) throw new AiCallError("timeout", "timed out");
        throw new AiCallError("unreachable", "the model server closed the connection");
      }
      if (!res.ok) throw new AiCallError("http", `HTTP ${res.status}`, res.status);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AiCallError("http", "the model server didn't answer JSON");
      }
      const content = (json as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
        ?.message?.content;
      if (typeof content !== "string" || content.trim() === "")
        throw new AiCallError("empty", "no answer");
      return content;
    },
  };
}
