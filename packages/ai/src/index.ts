import { type AiSettings, aiEnabled } from "./config.ts";
import { openaiCompat } from "./provider.ts";
import { AiCache, AiGate, type AiRuntime } from "./run.ts";

export * from "./config.ts";
export * from "./describe.ts";
export * from "./prompts.ts";
export * from "./provider.ts";
export * from "./run.ts";
export * from "./tasks/adjust.ts";
export * from "./tasks/enrich.ts";
export * from "./tasks/interpret.ts";
export * from "./tasks/rerank.ts";
export * from "./tasks/tweak.ts";

/** The runtime for configured settings, or null when the AI layer is off. */
export function createAiRuntime(
  settings: AiSettings,
  log: (line: string) => void = (line) => console.error(line),
): AiRuntime | null {
  if (!aiEnabled(settings)) return null;
  return {
    provider: openaiCompat(settings),
    timeoutMs: settings.timeoutMs,
    cache: new AiCache(),
    gate: new AiGate(),
    log,
  };
}
