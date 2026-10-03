// Every user-facing string lives here, so a Hebrew (RTL) UI later is a translation job.
import {
  clusterLabel,
  decadeLabel,
  type Hint,
  languageLabel,
  scalarLabel,
  type TweakAxis,
  type TweakId,
} from "@abtune/engine";

export const t = {
  tagline: "A/B test your taste.",
  pitch: "Answer quick this-or-that questions. Get a playlist that sounds like you.",
  setup: {
    depth: "How deep?",
    length: "Playlist length",
    packs: "Question packs",
    start: "Start the quiz",
    songs: (n: number) => `${n} songs`,
  },
  modes: {
    10: { name: "Quick", time: "~1 min" },
    20: { name: "Classic", time: "~2 min" },
    50: { name: "Deep dive", time: "~5 min" },
    100: { name: "Obsessed", time: "~10 min" },
  } as Record<number, { name: string; time: string }>,
  quiz: {
    progress: (pos: number, mode: number) => `${pos} / ${mode}`,
    back: "Back",
    both: "Both!",
    skip: "Skip",
    or: "or",
    keys: "← → pick · ↑ both · ↓ skip · ⌫ back",
    swipe: "Tap or swipe toward your pick",
    quit: "Start over",
  },
  result: {
    yourPersonality: "Your music personality",
    builtFrom: (n: number) => `Built from ${n} answer${n === 1 ? "" : "s"}`,
    exhausted: (n: number) =>
      `You've answered every question in your packs (${n} answers). This is as sharp as it gets!`,
    topGenres: "Top genres",
    noGenres: "No genre preference: a bit of everything.",
    era: "Era",
    anyEra: "Any era",
    profile: "Sound profile",
    lowEvidence: "not enough answers yet",
    showValues: "Show values",
    hideValues: "Hide values",
    playlist: "Your playlist",
    reshuffle: "Reshuffle",
    tenMore: "Answer 10 more",
    export: "Export",
    startOver: "Start over",
    tweak: "Tweak",
    resetTweaks: "Reset",
    tweaked: (names: string[]) => `tweaked: ${names.join(", ")}`,
    feedbackAsk: "Is this playlist you?",
    feedbackThanks: "Thanks! Saved on this device only.",
    loading: "Picking your songs…",
    catalogLoading: "Warming up the music catalog…",
    noCatalog: "No music catalog is installed, so there's no playlist yet. Install the dev sample:",
    noCatalogCommand: "docker compose run --rm catalog",
    catalogError: "The music catalog failed to load. Check the server log.",
    stale: "ABTune was updated on the server. Reload the page to continue.",
    reload: "Reload",
    serverDown: "Can't reach the ABTune server.",
    retry: "Try again",
    shortPlaylist: "The catalog ran out of songs that fit, so this playlist is shorter.",
    relaxed: "Few songs matched exactly, so the mix was widened a little.",
    openOnMusicBrainz: "Open on MusicBrainz",
    more: (n: number) => `＋${n} deeper cuts`,
    moreLoading: "Digging deeper…",
    actionFailed: "That didn't work. Try again?",
    songActions: (title: string) => `More for ${title}`,
    youtube: "YouTube",
    spotify: "Spotify",
    musicBrainz: "MusicBrainz",
    swap: "Swap",
    swapLabel: (title: string) => `Swap ${title} for another song`,
    data: "Music data",
  },
  share: {
    button: "Share",
    title: "Share your playlist",
    close: "Close",
    link: "Link to this card and playlist",
    copy: "Copy link",
    copied: "Copied",
    copyFailed: "Select the link and copy it",
    shareLink: "Share link…",
    image: "Card image",
    makingImage: "Drawing your card…",
    saveImage: "Save image",
    shareImage: "Share image…",
    privacy:
      "The link holds your taste profile and playlist settings. Your answers stay on this device.",
    shareText: (name: string) => `My music personality: ${name}. Take the quiz and get yours.`,
    onThePlaylist: "On the playlist",
    tagline: "ABTune · A/B test your taste",
    imageAlt: (name: string) => `Music personality card: ${name}`,
    // The shared view (someone opened a link).
    sharedKicker: "A shared music personality",
    playlist: "The playlist",
    takeQuiz: "Take the quiz yourself",
    yourOwn: "Back to your own result",
    broken:
      "This share link is broken or was cut off. Ask for the link again, or take the quiz yourself.",
    otherVersion:
      "This link was made with another version of ABTune or its music catalog, so some songs may differ.",
    shortened: "Some of the changes made to this playlist could not be repeated here.",
  },
  footerNoCatalog: "No catalog installed yet",
  catalogLine: (version: string, tracks: number) =>
    `${version} · ${tracks.toLocaleString("en-US")} songs`,
};

/** Pack toggles on the setup screen. Community packs fall back to their name. */
export const PACKS: Readonly<Record<string, { name: string; about: string }>> = {
  core: { name: "Core", about: "The essentials." },
  context: { name: "Moments", about: "Workouts, road trips, dinner parties." },
  deep: { name: "Deep cuts", about: "Follow-ups that unlock as you answer." },
  vibe: { name: "Vibe checks", about: "Cats or dogs? Taste beyond music." },
  spicy: {
    name: "Spicy 🌶️",
    about: "Polarizing topics (opt-in). They only nudge the sound, and never leave this device.",
  },
  il: {
    name: "Include Israeli music 🇮🇱",
    about: "Asks about Hebrew songs, then Israeli artists if you want them.",
  },
};

export function packName(pack: string): string {
  return PACKS[pack]?.name ?? pack.replace(/_/g, " ");
}

/** Genre tile emoji (no artist photos or covers: HANDOFF §13). */
const GENRE_EMOJI: Readonly<Record<string, string>> = {
  classic_rock: "🎸",
  alt_indie: "🎧",
  metal: "🤘",
  punk: "🧷",
  pop: "🎤",
  dance_pop: "💃",
  hiphop: "🎙️",
  rnb_soul: "🎷",
  funk_disco: "🪩",
  house_techno: "🎛️",
  edm: "⚡",
  chill_ambient: "🌙",
  synth_newwave: "🎹",
  folk: "🪕",
  country: "🤠",
  blues: "🎺",
  jazz: "🎶",
  classical: "🎻",
  soundtrack: "🎬",
  reggae: "🌴",
  latin: "💥",
  world: "🌍",
  mizrahi: "🪘",
  kpop: "✨",
};

export const genreEmoji = (g: string | null) => (g ? (GENRE_EMOJI[g] ?? "🎵") : "🎵");
export const genreName = (g: string | null) => (g ? clusterLabel(g) : "");

/** "80s–90s", "the 80s". */
function eraText(decades: readonly string[]): string {
  return decades.length === 1
    ? `the ${decadeLabel(decades[0] as string)}`
    : decades.map(decadeLabel).join("–");
}

const SCALAR_HINTS: Readonly<Record<string, { low: string; high: string }>> = {
  energy: { low: "Energy: mellow", high: "Energy: turned up" },
  valence: { low: "Mood: moody", high: "Mood: sunny" },
  dance: { low: "More listening than dancing", high: "Built to dance" },
  acoustic: { low: "Texture: electric", high: "Texture: organic" },
  tempo: { low: "Tempo: unhurried", high: "Tempo: fast" },
  mainstream: { low: "Deep-cut digger", high: "Hits over deep cuts" },
};

export function hintText(h: Hint): string {
  switch (h.kind) {
    case "era":
      return `Era locking in: ${eraText(h.decades)}`;
    case "genre":
      return h.genres.length === 1
        ? `Leaning ${clusterLabel(h.genres[0] as string)}`
        : `${clusterLabel(h.genres[0] as string)} meets ${clusterLabel(h.genres[1] as string)}`;
    case "language":
      return `${languageLabel(h.language)} in the mix`;
    case "scalar": {
      const s = SCALAR_HINTS[h.dim];
      if (s) return s[h.pole];
      const l = scalarLabel(h.dim);
      return `${l.name}: ${h.pole === "high" ? l.high : l.low}`;
    }
  }
}

export const TWEAK_LABELS: Readonly<Record<TweakId, string>> = {
  more_energy: "More energy",
  calmer: "Calmer",
  happier: "Happier",
  moodier: "Moodier",
  more_hits: "More hits",
  deeper_cuts: "Deeper cuts",
  newer: "Newer",
  older: "Older",
};

/** Per axis: [down, up] button ids. */
export const TWEAK_PAIRS: Readonly<Record<TweakAxis, readonly [TweakId, TweakId]>> = {
  energy: ["calmer", "more_energy"],
  mood: ["moodier", "happier"],
  popularity: ["deeper_cuts", "more_hits"],
  era: ["older", "newer"],
};

/** "more energy ×2", "older". */
export function tweakSummary(axis: TweakAxis, steps: number): string {
  const [down, up] = TWEAK_PAIRS[axis];
  const name = TWEAK_LABELS[steps > 0 ? up : down].toLowerCase();
  return Math.abs(steps) > 1 ? `${name} ×${Math.abs(steps)}` : name;
}

export const TRAIT_LABELS = {
  energy: { hi: "High energy", lo: "Laid-back" },
  mood: { bright: "Bright", dark: "Dark" },
  era: { retro: "Retro", modern: "Modern" },
  texture: { organic: "Organic", electric: "Electric" },
} as const;

export const EXPORT_LABELS = {
  m3u: { name: "M3U", about: "Music players (VLC, foobar2000)" },
  csv: { name: "CSV", about: "Spreadsheets & playlist-transfer tools" },
  xspf: { name: "XSPF", about: "Open playlist format, with ISRCs" },
  json: { name: "JSON", about: "Everything, incl. your profile & seed" },
} as const;
