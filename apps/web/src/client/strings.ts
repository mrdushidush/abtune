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
    busy: "Lots of playlists in a row. Yours is coming in a few seconds…",
    retry: "Try again",
    shortPlaylist: "The catalog ran out of songs that fit, so this playlist is shorter.",
    relaxed: "Few songs matched exactly, so the mix was widened a little.",
    openOnMusicBrainz: "Open on MusicBrainz",
    more: (n: number) => `＋${n} deeper cuts`,
    moreLoading: "Digging deeper…",
    actionFailed: "That didn't work. Try again?",
    actionBusy: "Too many changes in a row. Wait a few seconds, then try again.",
    songActions: (title: string) => `More for ${title}`,
    youtube: "YouTube",
    spotify: "Spotify",
    musicBrainz: "MusicBrainz",
    swap: "Swap",
    swapLabel: (title: string) => `Swap ${title} for another song`,
    data: "Music data",
  },
  ai: {
    // Setup (HANDOFF §4.1 "AI on/off").
    legend: "AI",
    setupTitle: "AI touches",
    setupAbout: (model: string) =>
      `An AI model on this server (${model}) reads your answers and fine-tunes the playlist. Nothing is stored.`,
    sensitiveTitle: "Include sensitive answers",
    sensitiveAbout:
      "Spicy questions marked sensitive (like politics) are never sent unless you tick this. They would go to this server's AI only, are not stored, and are never in share links.",
    // Result.
    reading: "The AI is reading your answers…",
    skip: "Skip AI",
    failed: {
      off: "AI is off on this server, so this is the classic playlist.",
      timeout: "The AI took too long, so this is the classic playlist.",
      unreachable: "The AI server didn't answer, so this is the classic playlist.",
      invalid: "The AI's answer didn't make sense, so this is the classic playlist.",
      oversized: "The AI's answer didn't make sense, so this is the classic playlist.",
      busy: "The AI is busy with other requests, so this is the classic playlist.",
    } as Record<string, string>,
    retry: "Ask again",
    madeBy: "Fine-tuned by AI",
    rerankFailed: "The AI couldn't pick from the shortlist this time; these are the classic picks.",
    picking: "The AI is picking your songs…",
    // T3: the free-text tweak.
    textLabel: "Describe it",
    textPlaceholder: "rainy Sunday, a 5k run, 90s road trip…",
    textGo: "Tweak",
    textBusy: "Thinking…",
    textActive: (text: string) => `“${text}”`,
    textClear: "Remove this tweak",
    textFailed: {
      off: "AI is off on this server.",
      timeout: "The AI took too long. Try again?",
      unreachable: "The AI server didn't answer. Try again?",
      invalid: "The AI couldn't make sense of that. Try other words?",
      oversized: "The AI couldn't make sense of that. Try other words?",
      busy: "The AI is busy with other requests. Try again in a moment?",
    } as Record<string, string>,
    why: "Why it's here",
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
    storyAsk: "What's your music personality?",
    formats: { post: "Post 4:5", story: "Story 9:16" },
    opensOn: (host: string) => `The link opens on ${host}, the public ABTune.`,
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
  // Hand-off to TuneMyMusic's "Free text" import, which works for every visitor and music app.
  handoff: {
    button: "Add to your music app",
    title: "Add to your music app",
    close: "Close",
    intro:
      "TuneMyMusic, a free transfer site, builds this playlist in your app. You sign in to your app there, never here.",
    steps: (n: number) => [
      `Tap your app. ABTune copies the ${n} songs and opens TuneMyMusic.`,
      "Paste the list into the box and tap Convert song list.",
      "Tap Transfer, then sign in to your app.",
    ],
    copied: (n: number) => `✓ ${n} songs copied. Paste them on TuneMyMusic.`,
    copyFailed: "Couldn't copy by itself. Copy this list, then paste it on TuneMyMusic:",
    copyAgain: "Copy the list again",
    listLabel: "The song list",
    fine: "Free for up to 500 songs. TuneMyMusic isn't part of ABTune, and ABTune sends it nothing: you paste the list yourself.",
  },
  spotify: {
    button: "Save to Spotify",
    title: "Save to Spotify",
    close: "Close",
    checking: "Checking Spotify…",
    serverDown: "Can't reach the ABTune server.",
    retry: "Try again",
    copy: "Copy",
    copied: "Copied",
    // Setup wizard (HANDOFF §11.1): the server has no Spotify app yet.
    setupTitle: "Set up Spotify (once)",
    setupIntro:
      "ABTune saves playlists through your own Spotify app. It takes about 5 minutes, and the account that creates the app needs Spotify Premium.",
    stepDashboard: "Open the Spotify developer dashboard and create an app.",
    dashboard: "Open the dashboard ↗︎",
    stepApp: "Name it anything that doesn't start with “Spot”, and tick Web API.",
    stepRedirect: "Add this redirect URI, exactly as shown:",
    stepUsers:
      "Under User Management, add the Spotify accounts of the people who will use this ABTune (up to 4 besides you).",
    stepEnv: "Add these lines to the .env file next to compose.yaml:",
    clientIdHint: "Paste your app's Client ID (from its Settings page) after SPOTIFY_CLIENT_ID=.",
    stepRestart: "Restart ABTune so it reads them:",
    restartCommand: "docker compose up -d",
    restartOther: "Without Docker: stop and start pnpm --filter @abtune/web start.",
    checkAgain: "Done, check again",
    stillMissing: (names: string) => `Still missing or invalid: ${names}.`,
    // Opened at another address than the redirect URI's.
    wrongHost: (origin: string) =>
      `Spotify sign-in only works at ${origin}, the address registered with Spotify.`,
    openThere: "Open this playlist there",
    // Not connected yet.
    connectIntro: "Connect your Spotify account to save this playlist there.",
    connectScope:
      "ABTune can only create playlists and add songs to them. It can't see your library or what you listen to.",
    connect: "Connect Spotify",
    outcome: {
      connected: "",
      denied: "Spotify sign-in was cancelled.",
      not_allowed:
        "Spotify won't let this account use the app yet. The app's owner adds it under User Management in the Spotify dashboard, and their Premium must be active.",
      not_configured: "Spotify isn't set up on this server yet.",
      expired: "That sign-in took too long or came back to another browser. Try again.",
      error: "Spotify sign-in didn't work. Try again.",
    },
    // Connected.
    connectedAs: (name: string) => `Connected as ${name}`,
    disconnect: "Disconnect",
    disconnected:
      "Disconnected. To remove ABTune's access completely, visit spotify.com/account/apps.",
    name: "Playlist name",
    public: "Show it on my Spotify profile",
    save: (n: number) => `Save ${n} songs`,
    backfillNote:
      "Songs Spotify doesn't have are swapped for similar ones, so you get all of them.",
    saving: (n: number) => `Finding ${n} songs on Spotify…`,
    done: "Saved to Spotify",
    doneCount: (n: number, name: string) => `${n} songs in “${name}”.`,
    matchLine: (found: number, swapped: number) =>
      swapped === 0
        ? `All ${found} found on Spotify.`
        : `${found} found on Spotify · ${swapped} swapped for similar songs.`,
    missingLine: (n: number) =>
      `${n} song${n === 1 ? "" : "s"} couldn't be found or replaced, so the playlist is shorter.`,
    open: "Open in Spotify ↗︎",
    swaps: "What was swapped",
    errors: {
      quota_exceeded:
        "This Spotify app has used up its request quota for now. Try again later, or export the playlist instead.",
      rate_limited: (s: number | null) =>
        s
          ? `Spotify asked to slow down. Try again in about ${s} seconds.`
          : "Spotify asked to slow down. Try again in a minute.",
      forbidden:
        "Spotify refused. This account may not be on the app's User Management list, or the app owner's Premium has lapsed.",
      not_connected: "Your Spotify sign-in has expired. Connect again.",
      no_matches: "None of these songs are on Spotify.",
      network: "Spotify didn't answer. Try again?",
      busy: "This playlist is still being saved.",
      stale: "ABTune was updated on the server. Reload the page to continue.",
      other: "Saving to Spotify didn't work. Try again?",
      partial: "The playlist was created, but not every song made it in:",
    },
    exportInstead: "Export CSV instead",
  },
  footerNoCatalog: "No catalog installed yet",
  privacyLine:
    "No login. Your answers stay in this browser; the server only gets your taste profile to pick the songs.",
  statsLine:
    "This site counts finished quizzes, shares and exports: numbers only, nothing about you.",
  source: "Open source on GitHub",
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
