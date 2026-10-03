import { archetypeName, type Dimensions, type TasteVector, traits } from "@abtune/engine";
import { useMemo, useState } from "react";
import { TRAIT_LABELS, t } from "../strings.ts";
import { DecadeColumns, GenreBars, ProfileTable, Radar, scalarReadings } from "./ProfileCharts.tsx";

/**
 * The music personality card (HANDOFF §4.3): archetype, radar, top genres, decades, answer count.
 * Computed in the browser from the profile, so it works without a catalog. Never shows answers.
 */
export function PersonalityCard({
  dims,
  taste,
  answered,
}: {
  dims: Dimensions;
  taste: TasteVector;
  answered: number;
}) {
  const [table, setTable] = useState(false);
  const tr = traits(dims, taste);
  const readings = useMemo(() => scalarReadings(dims, taste), [dims, taste]);
  const chips = [
    TRAIT_LABELS.energy[tr.energy],
    TRAIT_LABELS.mood[tr.mood],
    TRAIT_LABELS.era[tr.era],
    TRAIT_LABELS.texture[tr.texture],
  ];
  return (
    <section
      aria-labelledby="archetype"
      className="rounded-[28px] bg-gradient-to-br from-side-a/70 via-profile/60 to-side-b/70 p-[2px]"
    >
      <div className="flex flex-col gap-6 rounded-[26px] bg-surface px-5 py-6">
        <header className="text-center">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-text-3">
            {t.result.yourPersonality}
          </p>
          <h1 id="archetype" className="mt-1 text-4xl font-black tracking-tight text-balance">
            {archetypeName(tr)}
          </h1>
          <ul className="mt-3 flex flex-wrap justify-center gap-1.5">
            {chips.map((c) => (
              <li
                key={c}
                className="rounded-full bg-raised px-2.5 py-1 text-xs font-semibold text-text-2"
              >
                {c}
              </li>
            ))}
          </ul>
        </header>

        <div>
          <h2 className="mb-1 text-sm font-bold text-text-2">{t.result.profile}</h2>
          <Radar readings={readings} />
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="mb-2 text-sm font-bold text-text-2">{t.result.topGenres}</h2>
            <GenreBars dims={dims} taste={taste} />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-bold text-text-2">{t.result.era}</h2>
            <DecadeColumns dims={dims} taste={taste} />
          </div>
        </div>

        <footer className="flex items-center justify-between gap-3 text-sm text-text-3">
          <span>{t.result.builtFrom(answered)}</span>
          <button
            type="button"
            className="rounded-lg px-2 py-1 font-semibold text-text-2 underline-offset-4 hover:underline"
            aria-expanded={table}
            onClick={() => setTable((x) => !x)}
          >
            {table ? t.result.hideValues : t.result.showValues}
          </button>
        </footer>
        {table && <ProfileTable readings={readings} dims={dims} taste={taste} />}
      </div>
    </section>
  );
}
