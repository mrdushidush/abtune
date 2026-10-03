import { describe, expect, it } from "vitest";
import {
  csvField,
  EXPORT_FORMATS,
  type ExportPlaylist,
  exportPlaylist,
  slug,
  toCSV,
  toJSON,
  toM3U,
  toXSPF,
  xmlText,
} from "../src/index.ts";

const playlist: ExportPlaylist = {
  title: "Neon Nostalgist · Synth & New Wave 80s",
  description: "20 answers · seed 9f3a…",
  catalog_version: "catalog-2026.09",
  engine_version: "0.2.0+bank.deadbeef",
  seed: "9f3a000000000001",
  length: 3,
  taste: {
    target: [10, -20],
    weight: [100, 50],
    decades: [600, 400],
    genres: null,
    languages: null,
  },
  tweaks: { energy: 1 },
  tracks: [
    {
      track_id: "11111111-1111-4111-8111-111111111111",
      title: "Take On Me",
      artist: "a-ha",
      album: "Hunting High and Low",
      year: 1985,
      isrcs: ["GBAYE8500001", "USWB10000002"],
      length_ms: 225_000,
    },
    {
      track_id: "22222222-2222-4222-8222-222222222222",
      title: "יש לי סיכוי",
      artist: "אריק איינשטיין",
      album: null,
      year: null,
      isrcs: [],
      length_ms: null,
    },
    {
      track_id: "33333333-3333-4333-8333-333333333333",
      title: 'Rock & Roll, "Part 2" <live>',
      artist: "=Gary\nGlitter",
      album: "Glam, Vol. 1",
      year: 1972,
      isrcs: ["GBAAA7200003"],
      length_ms: 189_499,
    },
  ],
};

describe("M3U", () => {
  it("writes extended M3U with MusicBrainz locations", () => {
    expect(toM3U(playlist)).toBe(
      [
        "#EXTM3U",
        "#PLAYLIST:Neon Nostalgist · Synth & New Wave 80s",
        "#EXTINF:225,a-ha - Take On Me",
        "https://musicbrainz.org/recording/11111111-1111-4111-8111-111111111111",
        "#EXTINF:-1,אריק איינשטיין - יש לי סיכוי",
        "https://musicbrainz.org/recording/22222222-2222-4222-8222-222222222222",
        '#EXTINF:189,=Gary Glitter - Rock & Roll, "Part 2" <live>',
        "https://musicbrainz.org/recording/33333333-3333-4333-8333-333333333333",
        "",
      ].join("\n"),
    );
  });
});

describe("CSV", () => {
  it("writes RFC 4180 with one ISRC per row", () => {
    expect(toCSV(playlist)).toBe(
      [
        "Title,Artist,Album,Year,ISRC,MusicBrainz ID",
        "Take On Me,a-ha,Hunting High and Low,1985,GBAYE8500001,11111111-1111-4111-8111-111111111111",
        "יש לי סיכוי,אריק איינשטיין,,,,22222222-2222-4222-8222-222222222222",
        `"Rock & Roll, ""Part 2"" <live>","'=Gary\nGlitter","Glam, Vol. 1",1972,GBAAA7200003,33333333-3333-4333-8333-333333333333`,
        "",
      ].join("\r\n"),
    );
  });

  it("defuses formulas and quotes edge whitespace", () => {
    expect(csvField("+44")).toBe("'+44");
    expect(csvField("@home")).toBe("'@home");
    expect(csvField("-ish")).toBe("'-ish");
    expect(csvField(" padded")).toBe('" padded"');
    expect(csvField("a-ha")).toBe("a-ha");
    expect(toCSV(playlist).charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe("XSPF", () => {
  it("escapes XML and lists identifiers", () => {
    const xml = toXSPF(playlist);
    expect(xml).toContain('<playlist version="1" xmlns="http://xspf.org/ns/0/">');
    expect(xml).toContain("<title>Neon Nostalgist · Synth &amp; New Wave 80s</title>");
    expect(xml).toContain(
      "<identifier>https://musicbrainz.org/recording/11111111-1111-4111-8111-111111111111</identifier>",
    );
    expect(xml).toContain("<identifier>urn:isrc:GBAYE8500001</identifier>");
    expect(xml).toContain("<identifier>urn:isrc:USWB10000002</identifier>");
    expect(xml).toContain("<title>Rock &amp; Roll, &quot;Part 2&quot; &lt;live&gt;</title>");
    expect(xml).toContain("<creator>=Gary Glitter</creator>");
    expect(xml).toContain("<duration>225000</duration>");
    // The Hebrew track has no album, year or duration.
    const hebrew = xml.split("<track>")[2] as string;
    expect(hebrew).toContain("<title>יש לי סיכוי</title>");
    expect(hebrew).not.toContain("<album>");
    expect(hebrew).not.toContain("<duration>");
    expect(xml.match(/<track>/g)).toHaveLength(3);
  });

  it("drops characters XML can't hold", () => {
    expect(xmlText("a\u0001b\u000bc'")).toBe("abc&apos;");
  });
});

describe("JSON", () => {
  it("carries the profile, never answers", () => {
    const parsed = JSON.parse(toJSON(playlist));
    expect(parsed).toMatchObject({
      format: "abtune.playlist",
      version: 1,
      seed: playlist.seed,
      taste: playlist.taste,
      tweaks: { energy: 1 },
    });
    expect(parsed.tracks).toHaveLength(3);
    expect(Object.keys(parsed)).not.toContain("answers");
    expect(Object.keys(parsed)).not.toContain("answer_log");
  });
});

describe("exportPlaylist", () => {
  it("names files from the title", () => {
    expect(slug(playlist.title)).toBe("neon-nostalgist-synth-new-wave-80s");
    expect(slug("Café Ñoño")).toBe("cafe-nono");
    expect(slug("אריק")).toBe("abtune-playlist");
    expect(slug("x".repeat(100))).toHaveLength(60);
  });

  it("produces every format", () => {
    const files = EXPORT_FORMATS.map((f) => exportPlaylist(f, playlist));
    expect(files.map((f) => f.filename)).toEqual([
      "neon-nostalgist-synth-new-wave-80s.m3u8",
      "neon-nostalgist-synth-new-wave-80s.csv",
      "neon-nostalgist-synth-new-wave-80s.xspf",
      "neon-nostalgist-synth-new-wave-80s.json",
    ]);
    for (const f of files) expect(f.content.length).toBeGreaterThan(100);
  });
});
