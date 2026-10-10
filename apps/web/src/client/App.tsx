import bank from "virtual:abtune-bank";
import { useEffect, useReducer, useState } from "react";
import { Quiz } from "./screens/Quiz.tsx";
import { Result } from "./screens/Result.tsx";
import { Setup } from "./screens/Setup.tsx";
import { Shared } from "./screens/Shared.tsx";
import {
  type AppAction,
  type AppState,
  appReducer,
  loadState,
  randomQuizSeed,
  saveState,
  screenOf,
} from "./state/app.ts";
import { useHealth } from "./state/hooks.ts";
import { shareCodeOf } from "./state/share.ts";
import { takeOutcome } from "./state/spotify.ts";
import { setCounting } from "./state/stats.ts";
import { trackQuizStart, trackVisit } from "./state/via.ts";

const reducer = (s: AppState, a: AppAction) => appReducer(bank, s, a);

/** Back from Spotify's sign-in (`?spotify=…`): read once, and removed from the address bar. */
const signInOutcome = takeOutcome();

/**
 * Setup → quiz → result (HANDOFF §4.1). The screen is derived from the session, never stored. A
 * share link (`#s=…`) shows that card and playlist instead, leaving the visitor's own session alone.
 */
export function App() {
  const [state, dispatch] = useReducer(reducer, bank, loadState);
  const [health, refreshHealth] = useHealth();
  const [shared, setShared] = useState(() => shareCodeOf(location.hash));
  const [spotify, setSpotify] = useState(signInOutcome);
  const spotifyProps = { spotifyOutcome: spotify, onSpotifySeen: () => setSpotify(null) };
  const screen = shared ? "shared" : screenOf(bank, state);

  useEffect(() => {
    const onHash = () => setShared(shareCodeOf(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    saveState(bank, state);
  }, [state]);
  useEffect(() => {
    if (health.kind !== "loading") setCounting(health.kind === "ok" && health.health.stats);
  }, [health]);
  // A visit from one of the site's own links (`?via=`); waits, like every event, for health.
  useEffect(() => {
    trackVisit();
  }, []);
  // Block body on purpose: newer browsers return a Promise from scrollTo, and React would call
  // an effect's return value as its cleanup.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on screen change only
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  if (shared)
    return (
      <Shared
        bank={bank}
        code={shared}
        health={health}
        refreshHealth={refreshHealth}
        hasOwn={state.session !== null}
        {...spotifyProps}
        onLeave={() => {
          history.replaceState(null, "", location.pathname + location.search);
          setShared(null);
        }}
      />
    );
  if (screen === "setup" || !state.session)
    return (
      <Setup
        bank={bank}
        last={state.setup}
        health={health}
        onStart={(setup) => {
          const quizSeed = randomQuizSeed();
          trackQuizStart(quizSeed);
          dispatch({ type: "start", setup, quizSeed });
        }}
      />
    );
  if (screen === "quiz") return <Quiz bank={bank} session={state.session} dispatch={dispatch} />;
  return (
    <Result
      bank={bank}
      session={state.session}
      tweaks={state.tweaks}
      ai={state.ai}
      health={health}
      refreshHealth={refreshHealth}
      dispatch={dispatch}
      {...spotifyProps}
    />
  );
}
