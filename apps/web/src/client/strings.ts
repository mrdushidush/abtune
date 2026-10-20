// Every user-facing string lives here, so a Hebrew (RTL) UI later is a translation job.
import {
  clusterLabel,
  decadeLabel,
  ENERGY_HI,
  type Hint,
  languageLabel,
  MODERN_SHARE,
  RETRO_BEFORE,
  scalarLabel,
  TARGET_SCALE,
  type Traits,
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
  // Under the start button: what a visitor who scrolls, a search engine and an AI answer engine read
  // first. The questions are the page's structured data too (prerender.tsx), so they say only what
  // the page shows.
  about: {
    how: "How it works",
    steps: [
      {
        title: "Pick this or that",
        body: "Bon Jovi or Britney? 80s or 90s? Road trip or study session? Tap, swipe or use the arrow keys. Each card is the one that tells the quiz the most about you right now, so every quiz asks a different mix.",
      },
      {
        title: "Meet your music personality",
        body: "One of 16 types, from Sunburst Revivalist to Night-Drive Ghost, with your sound profile (energy, mood, danceability and six more), your top genres and your eras.",
        link: { text: "See all 16 music personalities", href: "/types" },
      },
      {
        title: "Take your playlist anywhere",
        body: "Songs people actually know, from an open catalog of 2 million. Tweak it, reshuffle it, add it to Spotify, Apple Music or YouTube Music, export it, or share a link that rebuilds it on any device.",
      },
    ],
    faq: "Questions",
    questions: [
      {
        q: "Is ABTune free?",
        a: "Yes. There's no account, no ads and nothing to install, and the code is open source on GitHub.",
      },
      {
        q: "Do I need Spotify?",
        a: "No. ABTune doesn't use Spotify's data: Spotify closed its recommendations and audio-features API to new apps in November 2024. The songs come from open music data (MusicBrainz, ListenBrainz and AcousticBrainz). When your playlist is ready, “Add to your music app” takes it to Spotify, Apple Music or YouTube Music.",
      },
      {
        q: "What happens to my answers?",
        a: "They stay in your browser. The server gets only your taste profile, a few dozen numbers, to pick the songs, and keeps no record of it. No cookies, no tracking IDs.",
      },
      {
        q: "How long does it take?",
        a: "About two minutes for 20 cards. 10 cards take a minute, and 50 or 100 give a sharper result. You can answer 10 more at any time to sharpen your playlist.",
      },
      {
        q: "How are the songs picked?",
        a: "Each answer moves your profile on 9 sound scales, 24 genres, 8 decades and 5 languages. The server scores the catalog against it, favors songs people know, keeps any artist to two songs and orders the list along an energy curve. The same answers always give the same playlist.",
      },
    ],
  },
  footerNoCatalog: "No catalog installed yet",
  privacyLine:
    "No login. Your answers stay in this browser; the server only gets your taste profile to pick the songs.",
  statsLine:
    "This site counts finished quizzes, shares, exports and which of its links brought you: numbers only, nothing about you.",
  source: "Open source on GitHub",
  privacy: "Privacy",
  terms: "Terms",
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

/** One type's page: a one-line summary (also the hub's line and the meta description), the copy, songs. */
export interface TypeCopy {
  readonly lead: string;
  readonly body: string;
  /** [title, artist]: well-known English songs the catalog itself puts in the type's corner. */
  readonly songs: readonly (readonly [string, string])[];
}

/**
 * The music personality pages (/types, written at build by type-pages.ts). Each type's songs are
 * catalog-2026.09.2 hits whose own features sit in the type's corner: energy ≥ +0.3 or ≤ 0, valence
 * ≥ +0.2 or ≤ −0.2, acoustic ≥ +0.2 or ≤ −0.2, and released in 1960–1999 or from 2000 (DECISIONS.md,
 * "Music personality pages").
 */
export const TYPE_PAGES = {
  hub: {
    title: "The 16 Music Personality Types · ABTune",
    description:
      "ABTune's music taste quiz gives you one of 16 music personalities, from four traits: energy, mood, era and texture. All 16, with songs that fit each one.",
    heading: "The 16 music personalities",
    intro:
      "ABTune's music taste quiz ends with one of 16 music personalities. Each is four traits read from your answers, and each trait has two sides, so 2 × 2 × 2 × 2 = 16. The same answers always give the same type.",
    traitsHeading: "The four traits",
    traits: [
      {
        name: "Energy",
        sides: `${TRAIT_LABELS.energy.hi} or ${TRAIT_LABELS.energy.lo}`,
        about: `Whether your picks lean to driving, loud songs or to calm ones. The line sits a little above the middle (+${(ENERGY_HI / TARGET_SCALE).toFixed(2)} on a scale from −1 to +1), because most of the quiz's cards lean energetic.`,
      },
      {
        name: "Mood",
        sides: `${TRAIT_LABELS.mood.bright} or ${TRAIT_LABELS.mood.dark}`,
        about:
          "Whether the songs you lean to sound happy, or sad, tense and brooding. It's how a song sounds, measured from the audio, not what its lyrics say.",
      },
      {
        name: "Era",
        sides: `${TRAIT_LABELS.era.retro} or ${TRAIT_LABELS.era.modern}`,
        about: `Modern when songs from the ${RETRO_BEFORE}s on make up at least ${Math.round(MODERN_SHARE * 100)}% of your decade mix, Retro when they make up less. With no answers about eras, it's Modern.`,
      },
      {
        name: "Texture",
        sides: `${TRAIT_LABELS.texture.organic} or ${TRAIT_LABELS.texture.electric}`,
        about:
          "Whether you lean to songs that sound played, with guitars, piano and voices, or to songs with synths, drum machines and a big studio sound.",
      },
    ],
    group: (energy: Traits["energy"], mood: Traits["mood"]) =>
      `${TRAIT_LABELS.energy[energy]} and ${TRAIT_LABELS.mood[mood].toLowerCase()}`,
  },
  page: {
    kicker: "Music personality",
    title: (name: string) => `${name}: Music Personality Type · ABTune`,
    description: (lead: string) =>
      `${lead} One of the 16 music personalities in ABTune's free music taste quiz.`,
    songs: "Songs that fit",
    song: (title: string, artist: string) => `${title} by ${artist}`,
    songsAbout: (t: Traits) =>
      `Well-known songs that ABTune's music catalog itself rates ${TRAIT_LABELS.energy[t.energy].toLowerCase()}, ${TRAIT_LABELS.mood[t.mood].toLowerCase()} and ${TRAIT_LABELS.texture[t.texture].toLowerCase()}, released ${t.era === "retro" ? `before ${RETRO_BEFORE}` : `in ${RETRO_BEFORE} or later`}.`,
    neighbors: "One trait away",
    neighbor: (trait: keyof Traits, from: string, to: string) => {
      const label = TRAIT_LABELS[trait] as Readonly<Record<string, string>>;
      return `${label[to]?.toLowerCase()} instead of ${label[from]?.toLowerCase()}`;
    },
  },
  nav: { home: "ABTune", all: "All 16 types", privacy: "Privacy", terms: "Terms" },
  cta: {
    heading: "What's yours?",
    body: "ABTune is a free music taste quiz. Pick this or that for about two minutes and get your music personality, your sound profile and a playlist that sounds like you. No login, and your answers stay in your browser.",
    link: "Take the quiz",
  },
  /** Keyed by trait key (personalities.ts). */
  types: {
    "hi.bright.retro.organic": {
      lead: "Big, sunny songs played by real bands, mostly from before 2000.",
      body: "You like music that lifts a room: a guitar riff everyone knows, a chorus made for singing along, a drummer you can hear. Your picks run upbeat and happy-sounding, lean to the decades before 2000, and favor songs that sound played rather than programmed. Soul, classic rock, 70s pop and 90s guitar bands all fit: the road-trip playlist, windows down.",
      songs: [
        ["Dancing Queen", "ABBA"],
        ["Respect", "Aretha Franklin"],
        ["Brown Eyed Girl", "Van Morrison"],
        ["Summer of ’69", "Bryan Adams"],
        ["Buddy Holly", "Weezer"],
      ],
    },
    "hi.bright.retro.electric": {
      lead: "Upbeat, plugged-in songs with synths and a big studio sound, mostly from before 2000.",
      body: "You like the sound of the 80s turned up: keyboards up front, drum machines, choruses built for arenas and dance floors. Your picks run upbeat and bright, lean to the decades before 2000, and favor songs that sound plugged in over acoustic ones. New wave, synth-pop, arena rock with keyboards and 90s alternative with the distortion on all fit.",
      songs: [
        ["Jump", "Van Halen"],
        ["Let’s Dance", "David Bowie"],
        ["Dancing in the Dark", "Bruce Springsteen"],
        ["The Final Countdown", "Europe"],
        ["Song 2", "Blur"],
      ],
    },
    "hi.bright.modern.organic": {
      lead: "Feel-good songs with real instruments, with plenty from 2000 on.",
      body: "You like music that sounds like a summer festival: guitars, stomps and claps, a crowd singing the hook back. Your picks run upbeat and bright, give the 2000s and later a good share, and favor a band sound over synths. Indie rock, folk-pop with a banjo, pop-punk and the guitar side of the charts all fit.",
      songs: [
        ["Hey Ya!", "OutKast"],
        ["I Will Wait", "Mumford & Sons"],
        ["You’ve Got the Love", "Florence + the Machine"],
        ["The Middle", "Jimmy Eat World"],
        ["Last Nite", "The Strokes"],
      ],
    },
    "hi.bright.modern.electric": {
      lead: "Upbeat, synth-driven songs made for moving, with plenty from 2000 on.",
      body: "You like music built to move to: a beat up front, synths with some shine, a hook that lands on the first listen. Your picks run upbeat and bright, give the 2000s and later a good share, and favor electronic sound over acoustic. Dance-pop, electropop and indie dance all fit. It's the biggest corner of ABTune's catalog: about one in five of its well-known English songs sounds like this.",
      songs: [
        ["Toxic", "Britney Spears"],
        ["Midnight City", "M83"],
        ["Only Girl (In the World)", "Rihanna"],
        ["Ready for the Floor", "Hot Chip"],
        ["I Bet You Look Good on the Dancefloor", "Arctic Monkeys"],
      ],
    },
    "hi.dark.retro.organic": {
      lead: "Driving, brooding songs played by real bands, mostly from before 2000.",
      body: "You like music with weight: a band playing hard, a minor key, a singer who means every word. Your picks run energetic but dark, lean to the decades before 2000, and favor songs that sound played rather than programmed. Hard rock, grunge and 90s alternative fit, and so does the heavier side of 70s rock. It's the rarest corner of ABTune's catalog: fewer than one in a hundred of its well-known English songs sound like this.",
      songs: [
        ["Zombie", "The Cranberries"],
        ["Black", "Pearl Jam"],
        ["Lady in Black", "Uriah Heep"],
        ["One of These Nights", "Eagles"],
        ["Weak", "Skunk Anansie"],
      ],
    },
    "hi.dark.retro.electric": {
      lead: "Driving, shadowy songs with synths and beats, mostly from before 2000.",
      body: "You like music for after dark: a pulsing bassline, cold synths, a beat that keeps moving while the mood stays tense. Your picks run energetic but dark, lean to the decades before 2000, and favor electronic sound over acoustic. Shadowy 80s pop, 90s dance music and big beat all fit.",
      songs: [
        ["Thriller", "Michael Jackson"],
        ["When Doves Cry", "Prince"],
        ["Insomnia", "Faithless"],
        ["Firestarter", "The Prodigy"],
        ["Self Control", "Laura Branigan"],
      ],
    },
    "hi.dark.modern.organic": {
      lead: "Loud, moody guitar songs, with plenty from 2000 on.",
      body: "You like music with a guitar and something to get off your chest: a riff up front, a chorus that hits hard, a singer working through it. Your picks run energetic but dark, give the 2000s and later a good share, and favor a band sound over synths. Emo, post-grunge and moody alternative rock fit. It's the second-rarest corner of ABTune's catalog: about one in a hundred of its well-known English songs sounds like this.",
      songs: [
        ["Yellow", "Coldplay"],
        ["Girl’s Not Grey", "AFI"],
        ["It’s Been Awhile", "Staind"],
        ["Ohio Is for Lovers", "Hawthorne Heights"],
        ["Hemorrhage (In My Hands)", "Fuel"],
      ],
    },
    "hi.dark.modern.electric": {
      lead: "Hard-hitting electronic and hip-hop songs with a dark edge, with plenty from 2000 on.",
      body: "You like music that hits you in the chest: heavy bass, hard beats, synths with teeth. Your picks run energetic but dark, give the 2000s and later a good share, and favor electronic sound over acoustic. Drum and bass, electro, dark dance-pop and hip-hop with a menacing beat all fit.",
      songs: [
        ["Harder, Better, Faster, Stronger", "Daft Punk"],
        ["Poker Face", "Lady Gaga"],
        ["Gold Digger", "Kanye West"],
        ["Witchcraft", "Pendulum"],
        ["Day ’n’ Nite (Nightmare)", "Kid Cudi"],
      ],
    },
    "lo.bright.retro.organic": {
      lead: "Easygoing, warm songs with guitar and piano, mostly from before 2000.",
      body: "You like music that takes its time: an acoustic guitar, a piano, a voice telling a story, a chorus you can hum. Your picks run calm and bright, lean to the decades before 2000, and favor songs that sound played rather than programmed. Folk, singer-songwriters, roots rock and a bit of reggae fit: a sunny afternoon on the porch, as the name says.",
      songs: [
        ["Three Little Birds", "Bob Marley & The Wailers"],
        ["The Weight", "The Band"],
        ["Wild World", "Cat Stevens"],
        ["Piano Man", "Billy Joel"],
        ["Kiss Me", "Sixpence None the Richer"],
      ],
    },
    "lo.bright.retro.electric": {
      lead: "Smooth, groovy songs with electric keys and basslines, mostly from before 2000.",
      body: "You like music with a slow strut: a funky bassline, electric keys, a groove that never hurries. Your picks run calm and bright, lean to the decades before 2000, and favor plugged-in sound over acoustic. 70s funk and soul, smooth 80s pop and late-90s downtempo all fit.",
      songs: [
        ["Theme From ‘Shaft’", "Isaac Hayes"],
        ["Low Rider", "War"],
        ["Superstition", "Stevie Wonder"],
        ["Kelly Watch the Stars", "Air"],
        ["Maneater", "Daryl Hall & John Oates"],
      ],
    },
    "lo.bright.modern.organic": {
      lead: "Gentle, warm songs with acoustic instruments, with plenty from 2000 on.",
      body: "You like music that feels like a good morning: an acoustic guitar, a ukulele or a whistled hook, a melody that makes you smile without trying hard. Your picks run calm and bright, give the 2000s and later a good share, and favor acoustic sound. Indie folk, singer-songwriter pop and soft acoustic hits all fit.",
      songs: [
        ["Mushaboom", "Feist"],
        ["Hey, Soul Sister", "Train"],
        ["Your Body Is a Wonderland", "John Mayer"],
        ["Home", "Edward Sharpe & The Magnetic Zeros"],
        ["Young Folks", "Peter Bjorn and John"],
      ],
    },
    "lo.bright.modern.electric": {
      lead: "Relaxed, sunny electronic songs, with plenty from 2000 on.",
      body: "You like music that glows: soft synths, a light beat, a hook that floats instead of shouting. Your picks run calm and bright, give the 2000s and later a good share, and favor electronic sound over acoustic. Indietronica, chilled electropop and dreamy synth songs all fit.",
      songs: [
        ["Fireflies", "Owl City"],
        ["Such Great Heights", "The Postal Service"],
        ["DARE", "Gorillaz"],
        ["Oblivion", "Grimes"],
        ["Lights", "Ellie Goulding"],
      ],
    },
    "lo.dark.retro.organic": {
      lead: "Slow, sad songs with guitar and piano, mostly from before 2000.",
      body: "You like music for staring out of a window: a quiet guitar, a piano, a voice close to the mic, a song that lets the sadness sit. Your picks run calm and dark, lean to the decades before 2000, and favor songs that sound played rather than programmed. Folk ballads, soul, classic rock's slow songs and 90s alternative ballads all fit.",
      songs: [
        ["The Sound of Silence", "Simon & Garfunkel"],
        ["Ain’t No Sunshine", "Bill Withers"],
        ["Wish You Were Here", "Pink Floyd"],
        ["Everybody Hurts", "R.E.M."],
        ["Hallelujah", "Jeff Buckley"],
      ],
    },
    "lo.dark.retro.electric": {
      lead: "Slow, shadowy songs with beats and atmosphere, mostly from before 2000.",
      body: "You like music that sounds like a city at 2 a.m.: a slow beat, a low bassline, a haze of synths and a voice that keeps its secrets. Your picks run calm and dark, lean to the decades before 2000, and favor electronic sound over acoustic. Trip-hop, sultry 80s and 90s soul and downtempo all fit.",
      songs: [
        ["Teardrop", "Massive Attack"],
        ["No Ordinary Love", "Sade"],
        ["6 Underground", "Sneaker Pimps"],
        ["Black Velvet", "Alannah Myles"],
        ["Missing", "Everything but the Girl"],
      ],
    },
    "lo.dark.modern.organic": {
      lead: "Quiet, heartfelt songs with acoustic instruments, with plenty from 2000 on.",
      body: "You like music that tells the truth softly: a fingerpicked guitar, a piano, a voice that sounds like it's singing to one person. Your picks run calm and dark, give the 2000s and later a good share, and favor acoustic sound. Indie folk, piano ballads and stripped-back singer-songwriters all fit.",
      songs: [
        ["Someone Like You", "Adele"],
        ["Skinny Love", "Bon Iver"],
        ["I Will Follow You Into the Dark", "Death Cab for Cutie"],
        ["Mad World", "Gary Jules"],
        ["Cannonball", "Damien Rice"],
      ],
    },
    "lo.dark.modern.electric": {
      lead: "Slow, moody electronic songs for late nights, with plenty from 2000 on.",
      body: "You like music for an empty road at night: slow synths, echoing beats, a voice drifting somewhere in the mix. Your picks run calm and dark, give the 2000s and later a good share, and favor electronic sound over acoustic. Alt-R&B, downtempo, chilled electronica and moody synth-pop all fit.",
      songs: [
        ["Thinkin Bout You", "Frank Ocean"],
        ["Archangel", "Burial"],
        ["Breathe", "Télépopmusik"],
        ["Sail", "AWOLNATION"],
        ["I Follow Rivers", "Lykke Li"],
      ],
    },
  } as Readonly<Record<string, TypeCopy>>,
};

export const EXPORT_LABELS = {
  m3u: { name: "M3U", about: "Music players (VLC, foobar2000)" },
  csv: { name: "CSV", about: "Spreadsheets & playlist-transfer tools" },
  xspf: { name: "XSPF", about: "Open playlist format, with ISRCs" },
  json: { name: "JSON", about: "Everything, incl. your profile & seed" },
} as const;
