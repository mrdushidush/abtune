import type { ExportFile } from "@abtune/connectors";

/** Save an export through the browser (no server round trip; works offline). */
export function download(file: ExportFile): void {
  saveBlob(new Blob([file.content], { type: file.mime }), file.filename);
}

/** Save any blob as a file through a temporary link. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
