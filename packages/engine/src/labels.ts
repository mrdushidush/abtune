// English display labels for dimension keys (titles, cards). Unknown keys get a readable fallback,
// so a community bank that adds a dimension still renders.

const CLUSTER_LABELS: Readonly<Record<string, string>> = {
  classic_rock: "Classic Rock",
  alt_indie: "Alt & Indie",
  metal: "Metal",
  punk: "Punk",
  pop: "Pop",
  dance_pop: "Dance Pop",
  hiphop: "Hip-Hop",
  rnb_soul: "R&B & Soul",
  funk_disco: "Funk & Disco",
  house_techno: "House & Techno",
  edm: "EDM",
  chill_ambient: "Chill & Ambient",
  synth_newwave: "Synth & New Wave",
  folk: "Folk",
  country: "Country",
  blues: "Blues",
  jazz: "Jazz",
  classical: "Classical",
  soundtrack: "Soundtrack",
  reggae: "Reggae",
  latin: "Latin",
  world: "World",
  mizrahi: "Mizrahi",
  kpop: "K-Pop",
};

const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  lang_en: "English",
  lang_he: "Hebrew",
  lang_fr: "French",
  lang_es: "Spanish",
  lang_other: "Other languages",
};

function fallback(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function clusterLabel(key: string): string {
  return CLUSTER_LABELS[key] ?? fallback(key);
}

export function languageLabel(key: string): string {
  return LANGUAGE_LABELS[key] ?? fallback(key);
}

/** `decNN` → first year of the decade: dec50–dec90 are 19xx, dec00–dec40 are 20xx. Null otherwise. */
export function decadeStart(key: string): number | null {
  const m = /^dec(\d\d)$/.exec(key);
  if (!m) return null;
  const nn = Number(m[1]);
  return nn >= 50 ? 1900 + nn : 2000 + nn;
}

/** dec80 → "80s", dec00 → "2000s", dec20 → "2020s". */
export function decadeLabel(key: string): string {
  const start = decadeStart(key);
  if (start === null) return fallback(key);
  return start >= 2000 ? `${start}s` : `${String(start).slice(2)}s`;
}
