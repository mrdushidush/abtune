import {
  AiCallError,
  type AiCallErrorKind,
  type AiProvider,
  type CompletionRequest,
  MAX_RESPONSE_BYTES,
} from "./provider.ts";

/**
 * A scripted stand-in model for tests (HANDOFF §10.5, §16 #8): returns canned text per task,
 * records every request (§16 #9 checks the payloads), and can fail like a real server.
 */
export type MockReply =
  | string
  /** Fail the way a real server would. */
  | { readonly fail: AiCallErrorKind }
  /** Never answer; ends when the caller's time limit aborts it. */
  | { readonly hang: true }
  | ((req: CompletionRequest) => string | Promise<string>);

export class MockProvider implements AiProvider {
  readonly id = "mock";
  readonly model: string;
  readonly calls: CompletionRequest[] = [];
  private readonly script: Map<string, MockReply[]>;

  /** Per task: one reply for every call, or a list used in order (the last one repeats). */
  constructor(script: Readonly<Record<string, MockReply | readonly MockReply[]>>, model = "mock") {
    this.model = model;
    this.script = new Map(
      Object.entries(script).map(([task, r]) => [
        task,
        Array.isArray(r) ? [...r] : [r as MockReply],
      ]),
    );
  }

  async complete(req: CompletionRequest): Promise<string> {
    this.calls.push(req);
    const list = this.script.get(req.task);
    if (!list || list.length === 0)
      throw new AiCallError("http", `mock: no reply for ${req.task}`, 500);
    const reply = (list.length > 1 ? list.shift() : list[0]) as MockReply;
    if (typeof reply === "function") return checkSize(await reply(req));
    if (typeof reply === "string") return checkSize(reply);
    if ("fail" in reply) throw new AiCallError(reply.fail, `mock: ${reply.fail}`);
    return new Promise<string>((_, reject) => {
      const stop = () => reject(new AiCallError("timeout", "mock: timed out"));
      if (req.signal.aborted) stop();
      else req.signal.addEventListener("abort", stop, { once: true });
    });
  }
}

/** Like a real server's body cap: an answer bigger than any valid one is `oversized`. */
function checkSize(text: string): string {
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
    throw new AiCallError("oversized", "mock: oversized");
  return text;
}
