import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Streaming sha256 of a file (hex). */
export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: 4 << 20 })) h.update(chunk);
  return h.digest("hex");
}
