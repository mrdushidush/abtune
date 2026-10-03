import { type ExportPlaylist, oneLine, recordingUrl } from "./types.ts";

/** Characters XML 1.0 forbids, even escaped. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

export function xmlText(s: string): string {
  return s
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const el = (indent: string, name: string, value: string) =>
  `${indent}<${name}>${xmlText(value)}</${name}>`;

/**
 * XSPF 1 (https://xspf.org/spec). Tracks carry identifiers, not locations: the MusicBrainz
 * recording URL and `urn:isrc:<code>` per ISRC, so a player or importer can resolve them.
 */
export function toXSPF(p: ExportPlaylist): string {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<playlist version="1" xmlns="http://xspf.org/ns/0/">',
    el("  ", "title", oneLine(p.title)),
    el("  ", "creator", "ABTune"),
    el("  ", "annotation", p.description),
    "  <trackList>",
  ];
  p.tracks.forEach((t, i) => {
    const s = "      ";
    out.push("    <track>");
    out.push(el(s, "identifier", recordingUrl(t.track_id)));
    for (const isrc of t.isrcs) out.push(el(s, "identifier", `urn:isrc:${isrc}`));
    out.push(el(s, "title", oneLine(t.title)));
    out.push(el(s, "creator", oneLine(t.artist)));
    if (t.album !== null) out.push(el(s, "album", oneLine(t.album)));
    out.push(el(s, "trackNum", String(i + 1)));
    if (t.length_ms !== null) out.push(el(s, "duration", String(t.length_ms)));
    out.push("    </track>");
  });
  out.push("  </trackList>", "</playlist>");
  return `${out.join("\n")}\n`;
}
