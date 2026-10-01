import bank from "virtual:abtune-bank";
import { questionText } from "@abtune/engine";
import { useEffect, useState } from "react";

interface Health {
  readonly version: string;
  readonly questions: number;
}

type ServerState = { kind: "loading" } | { kind: "ok"; health: Health } | { kind: "down" };

export function App() {
  const [server, setServer] = useState<ServerState>({ kind: "loading" });

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((health: Health) => setServer({ kind: "ok", health }))
      .catch(() => setServer({ kind: "down" }));
  }, []);

  const sample = bank.questions[0];
  const packs = Object.keys(bank.packs);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-8 px-4 py-10">
      <header className="text-center">
        <h1 className="text-5xl font-black tracking-tight">
          <span className="text-side-a">A</span>
          <span className="text-side-b">B</span>Tune
        </h1>
        <p className="mt-2 text-lg text-white/70">A/B test your taste.</p>
      </header>

      {sample && (
        <section aria-label="Sample question" className="flex flex-col gap-3">
          <p className="text-center text-sm uppercase tracking-widest text-white/50">
            {questionText(sample)}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {(["a", "b"] as const).map((side) => (
              <div
                key={side}
                className={`flex aspect-[3/4] flex-col items-center justify-center gap-3 rounded-3xl border-2 p-4 text-center ${
                  side === "a" ? "border-side-a/60 bg-side-a/10" : "border-side-b/60 bg-side-b/10"
                }`}
              >
                <span className="text-5xl" aria-hidden="true">
                  {sample[side].emoji}
                </span>
                <span className="text-lg font-bold leading-tight">{sample[side].label}</span>
              </div>
            ))}
          </div>
          <p className="text-center text-sm text-white/50">The quiz arrives in milestone M4.</p>
        </section>
      )}

      <section className="rounded-2xl bg-white/5 p-4 text-sm leading-relaxed text-white/70">
        <p>
          <strong className="text-white">{bank.questions.length}</strong> questions in{" "}
          {packs.length} packs ({packs.join(", ")}).
        </p>
        <p>
          Server:{" "}
          {server.kind === "loading"
            ? "checking…"
            : server.kind === "ok"
              ? `ok, v${server.health.version}, ${server.health.questions} questions`
              : "not reachable"}
        </p>
      </section>
    </main>
  );
}
