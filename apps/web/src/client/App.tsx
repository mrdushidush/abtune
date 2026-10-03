import bank from "virtual:abtune-bank";
import { useEffect, useReducer } from "react";
import { Quiz } from "./screens/Quiz.tsx";
import { Result } from "./screens/Result.tsx";
import { Setup } from "./screens/Setup.tsx";
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

const reducer = (s: AppState, a: AppAction) => appReducer(bank, s, a);

/** Setup → quiz → result (HANDOFF §4.1). The screen is derived from the session, never stored. */
export function App() {
  const [state, dispatch] = useReducer(reducer, bank, loadState);
  const [health, refreshHealth] = useHealth();
  const screen = screenOf(bank, state);

  useEffect(() => {
    saveState(bank, state);
  }, [state]);
  // Block body on purpose: newer browsers return a Promise from scrollTo, and React would call
  // an effect's return value as its cleanup.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on screen change only
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  if (screen === "setup" || !state.session)
    return (
      <Setup
        bank={bank}
        last={state.setup}
        health={health}
        onStart={(setup) => dispatch({ type: "start", setup, quizSeed: randomQuizSeed() })}
      />
    );
  if (screen === "quiz") return <Quiz bank={bank} session={state.session} dispatch={dispatch} />;
  return (
    <Result
      bank={bank}
      session={state.session}
      tweaks={state.tweaks}
      health={health}
      refreshHealth={refreshHealth}
      dispatch={dispatch}
    />
  );
}
