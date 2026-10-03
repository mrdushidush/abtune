import { type Bank, defaultPacks, LENGTHS, MODES } from "@abtune/engine";
import { useState } from "react";
import type { SetupChoice } from "../state/app.ts";
import type { HealthState } from "../state/hooks.ts";
import { PACKS, packName, t } from "../strings.ts";

const Logo = () => (
  <h1 className="text-6xl font-black tracking-tight">
    <span className="text-side-a">A</span>
    <span className="text-side-b">B</span>Tune
  </h1>
);

/** One option of a radio group, styled as a big chip (a real radio input underneath). */
function Chip({
  name,
  selected,
  onSelect,
  children,
}: {
  name: string;
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-1 cursor-pointer">
      <input
        type="radio"
        name={name}
        checked={selected}
        onChange={onSelect}
        className="peer sr-only"
      />
      <span className="flex min-h-12 flex-1 flex-col items-center justify-center rounded-2xl border-2 border-line bg-surface px-2 py-2 text-text-2 transition-colors hover:border-text-3 peer-checked:border-profile peer-checked:bg-profile/15 peer-checked:text-text peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-text">
        {children}
      </span>
    </label>
  );
}

const legend = "mb-3 text-sm font-bold uppercase tracking-widest text-text-3";

/** Landing + setup (HANDOFF §4.1): mode, playlist length, packs. */
export function Setup({
  bank,
  last,
  health,
  onStart,
}: {
  bank: Bank;
  last: SetupChoice | null;
  health: HealthState;
  onStart: (s: SetupChoice) => void;
}) {
  const [mode, setMode] = useState(last?.mode ?? 20);
  const [length, setLength] = useState(last?.length ?? 25);
  const [packs, setPacks] = useState<readonly string[]>(last?.packs ?? defaultPacks(bank));
  const optional = Object.keys(bank.packs).filter((p) => p !== "core");
  const toggle = (p: string) =>
    setPacks((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p].sort()));
  const catalog = health.kind === "ok" ? health.health.catalog : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-8 px-4 pb-10 pt-12">
      <header className="text-center">
        <Logo />
        <p className="mt-2 text-xl font-bold text-text">{t.tagline}</p>
        <p className="mt-2 text-text-2">{t.pitch}</p>
      </header>

      <fieldset>
        <legend className={legend}>{t.setup.depth}</legend>
        <div className="grid grid-cols-4 gap-2">
          {MODES.map((m) => (
            <Chip key={m} name="mode" selected={mode === m} onSelect={() => setMode(m)}>
              <span className="text-2xl font-black">{m}</span>
              <span className="text-xs font-semibold">{t.modes[m]?.name}</span>
              <span className="text-[11px] text-text-3">{t.modes[m]?.time}</span>
            </Chip>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className={legend}>{t.setup.length}</legend>
        <div className="flex gap-2">
          {LENGTHS.map((l) => (
            <Chip key={l} name="length" selected={length === l} onSelect={() => setLength(l)}>
              <span className="font-bold">{t.setup.songs(l)}</span>
            </Chip>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className={legend}>{t.setup.packs}</legend>
        <ul className="flex flex-col gap-2">
          {optional.map((p) => {
            const on = packs.includes(p);
            return (
              <li key={p}>
                <label className="flex cursor-pointer items-center gap-3 rounded-2xl bg-surface px-4 py-3">
                  <span className="flex-1">
                    <span className="block font-bold">{packName(p)}</span>
                    {PACKS[p] && (
                      <span className="block text-sm text-text-3">{PACKS[p].about}</span>
                    )}
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-checked={on}
                    checked={on}
                    onChange={() => toggle(p)}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className="relative h-7 w-12 shrink-0 rounded-full bg-line transition-colors peer-checked:bg-profile peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-text"
                  >
                    <span
                      className={`absolute top-1 size-5 rounded-full bg-text transition-[inset-inline-start] ${on ? "start-6" : "start-1"}`}
                    />
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <button
        type="button"
        className="min-h-14 rounded-2xl bg-gradient-to-r from-side-a to-side-b text-lg font-black text-ink shadow-[0_0_40px_-8px] shadow-profile/60 transition-transform active:scale-[0.98]"
        onClick={() => onStart({ mode, length, packs: [...new Set(["core", ...packs])].sort() })}
      >
        {t.setup.start} →
      </button>

      <p className="text-center text-xs text-text-3">
        {catalog
          ? t.catalogLine(catalog.version, catalog.tracks)
          : health.kind === "ok"
            ? t.footerNoCatalog
            : ""}
      </p>
    </main>
  );
}
