/**
 * AI settings from `.env` (HANDOFF §10.1, §14). v0.1 talks to local OpenAI-compatible servers only
 * (owner decision, 2026-10-03): LM Studio, Ollama, llama.cpp server, vLLM.
 */
export interface AiSettings {
  /** `none` (default): the AI layer is off. */
  readonly provider: "none" | "openai_compat";
  /** Up to and including `/v1`, e.g. http://127.0.0.1:1234/v1. */
  readonly baseUrl: string;
  readonly model: string;
  /** Sent as a Bearer token when set (most local servers need none). */
  readonly apiKey: string;
  /** Per call (§10.4: 20 s for a local model). */
  readonly timeoutMs: number;
  /** Optional `reasoning_effort` for thinking models (LM Studio + Qwen: `none`). */
  readonly reasoningEffort: string | null;
  /** T2 rerank: `llm` turns it on (needs the provider); off by default. */
  readonly rerank: boolean;
  /** The operator allows a per-session opt-in that sends sensitive answers (§13). */
  readonly allowSensitive: boolean;
  /** Test seam. */
  readonly fetch?: typeof fetch;
}

export const DEFAULT_AI_BASE_URL = "http://127.0.0.1:1234/v1";
export const DEFAULT_AI_TIMEOUT_MS = 20_000;

export const AI_OFF: AiSettings = {
  provider: "none",
  baseUrl: DEFAULT_AI_BASE_URL,
  model: "",
  apiKey: "",
  timeoutMs: DEFAULT_AI_TIMEOUT_MS,
  reasoningEffort: null,
  rerank: false,
  allowSensitive: false,
};

/** A setting that keeps the AI layer off, with what to fix. */
export interface AiSettingsProblem {
  readonly setting: string;
  readonly message: string;
}

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v?.trim() ?? "");

/**
 * Parse the environment. A bad value turns the AI layer off and is reported, so the app still
 * starts (the AI is optional).
 */
export function aiSettings(env: Readonly<Record<string, string | undefined>>): {
  settings: AiSettings;
  problems: AiSettingsProblem[];
} {
  const problems: AiSettingsProblem[] = [];
  const provider = (env.AI_PROVIDER ?? "none").trim().toLowerCase() || "none";
  const baseUrl = (env.AI_BASE_URL?.trim() || DEFAULT_AI_BASE_URL).replace(/\/+$/, "");
  const model = env.AI_MODEL?.trim() ?? "";
  const timeoutRaw = env.AI_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_AI_TIMEOUT_MS;
  const rerankRaw = (env.RERANK_BACKEND ?? "none").trim().toLowerCase() || "none";
  const base: AiSettings = {
    ...AI_OFF,
    baseUrl,
    model,
    apiKey: env.AI_API_KEY?.trim() ?? "",
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : DEFAULT_AI_TIMEOUT_MS,
    reasoningEffort: env.AI_REASONING_EFFORT?.trim() || null,
    allowSensitive: truthy(env.ALLOW_SENSITIVE_TO_AI),
  };
  if (timeoutRaw && base.timeoutMs !== timeoutMs)
    problems.push({ setting: "AI_TIMEOUT_MS", message: "must be a whole number of ms ≥ 1000" });
  if (rerankRaw !== "none" && rerankRaw !== "llm")
    problems.push({
      setting: "RERANK_BACKEND",
      message: `"${rerankRaw}" isn't supported; use none or llm`,
    });
  if (provider === "none") return { settings: base, problems };
  if (provider !== "openai_compat") {
    problems.push({
      setting: "AI_PROVIDER",
      message: `"${provider}" isn't supported in v0.1; use openai_compat (LM Studio, Ollama, llama.cpp, vLLM) or none`,
    });
    return { settings: base, problems };
  }
  let url: URL | null = null;
  try {
    url = new URL(baseUrl);
  } catch {}
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    problems.push({ setting: "AI_BASE_URL", message: "must be an http(s) URL ending in /v1" });
    return { settings: base, problems };
  }
  if (!model) {
    problems.push({ setting: "AI_MODEL", message: "is required (the model id your server lists)" });
    return { settings: base, problems };
  }
  return {
    settings: { ...base, provider: "openai_compat", rerank: rerankRaw === "llm" },
    problems,
  };
}

export const aiEnabled = (s: AiSettings) => s.provider !== "none";
