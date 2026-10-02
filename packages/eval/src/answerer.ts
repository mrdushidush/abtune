import {
  type Answerer,
  type Bank,
  bankIndex,
  type Choice,
  type GroupName,
  type Question,
  type Rng,
} from "@abtune/engine";
import type { Persona } from "./persona.ts";

/** A non-target key in a group the persona has targets for counts −NON_TARGET · v. */
export const NON_TARGET = 0.5;
/** Utilities closer than this are a tie: "both" if the persona likes them, else "skip". */
export const TIE = 0.05;
/**
 * Below this on both sides the persona skips: neither answer fits it, and picking the "less bad"
 * one would add evidence for something it doesn't want (a classical fan asked "Bon Jovi or
 * Britney?"). Mildly negative cards are still answered ("Around the world" for a Hebrew listener).
 */
export const SKIP_BELOW = -0.25;

function targets(persona: Persona, group: GroupName): Readonly<Record<string, number>> | undefined {
  return group === "genres"
    ? persona.clusters
    : group === "decades"
      ? persona.decades
      : persona.languages;
}

/**
 * How well an answer's effects fit the persona (HANDOFF §17 "closer to the persona targets"):
 * - scalar k with range [lo, hi]: |mid| − |v − mid|, i.e. how much closer v is than neutral 0;
 * - a target category: +v · its weight;
 * - another category in a group the persona has targets for: −NON_TARGET · v (moving away is good);
 * - anything the persona doesn't care about: 0.
 */
export function utility(
  bank: Bank,
  persona: Persona,
  fx: Readonly<Record<string, number>>,
): number {
  const { registry } = bankIndex(bank);
  let u = 0;
  for (const [key, v] of Object.entries(fx)) {
    const dim = registry.lookup.get(key);
    if (!dim) continue;
    if (dim.kind === "scalar") {
      const r = persona.scalars[key];
      if (!r) continue;
      const mid = (r[0] + r[1]) / 2;
      u += Math.abs(mid) - Math.abs(v - mid);
    } else {
      const t = targets(persona, dim.group);
      if (!t) continue;
      const w = t[key];
      u += w !== undefined ? v * w : -NON_TARGET * v;
    }
  }
  return u;
}

/** The persona's deterministic answer: the closer side; near-ties → both / skip; both bad → skip. */
export function personaChoice(bank: Bank, persona: Persona, q: Question): Choice {
  const ua = utility(bank, persona, q.a.fx);
  const ub = utility(bank, persona, q.b.fx);
  if (Math.max(ua, ub) < SKIP_BELOW) return "skip";
  if (Math.abs(ua - ub) < TIE) return Math.max(ua, ub) > 0 ? "both" : "skip";
  return ua > ub ? "a" : "b";
}

/**
 * The persona bot. With `noise` > 0, that share of a/b answers is flipped (seeded), to check that
 * tuning holds up for less consistent listeners.
 */
export function personaAnswerer(bank: Bank, persona: Persona, noise = 0, rng?: Rng): Answerer {
  if (noise > 0 && !rng) throw new Error("personaAnswerer: noise needs an rng");
  return (q) => {
    const choice = personaChoice(bank, persona, q);
    if (noise > 0 && rng && (choice === "a" || choice === "b") && rng.next() < noise) {
      return choice === "a" ? "b" : "a";
    }
    return choice;
  };
}
