// Worker entry: convert one AcousticBrainz high-level archive (see ab.ts).
import { parentPort, workerData } from "node:worker_threads";
import { convertHighlevelPart } from "./ab.ts";

const { archive, out } = workerData as { archive: string; out: string };
try {
  parentPort?.postMessage(await convertHighlevelPart(archive, out));
} catch (e) {
  parentPort?.postMessage({ error: (e as Error).stack ?? String(e) });
}
