import { type Bank, defaultPacks } from "@abtune/engine";

/** The Israeli pack: Hebrew cards and the Israeli artists. */
export const IL_PACK = "il";

export interface Locale {
  /** navigator.languages, e.g. ["he-IL", "en-US"]. */
  readonly languages: readonly string[];
  /** Intl's time zone, e.g. "Asia/Jerusalem". */
  readonly timeZone: string | undefined;
}

/** This browser's language list and time zone. */
export function browserLocale(): Locale {
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {}
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return { languages: nav?.languages ?? (nav?.language ? [nav.language] : []), timeZone };
}

/** A Hebrew browser language ("he", or the old "iw") or an Israeli time zone. */
export function israeliLocale({ languages, timeZone }: Locale): boolean {
  return (
    languages.some((l) => /^(he|iw)\b/i.test(l)) ||
    timeZone === "Asia/Jerusalem" ||
    timeZone === "Asia/Tel_Aviv"
  );
}

/**
 * The setup screen's starting packs (owner decision 2026-10-04, amends D8): the bank's defaults,
 * with the Israeli pack only for an Israeli locale. The toggle stays either way.
 */
export function startingPacks(bank: Bank, locale: Locale): string[] {
  const packs = defaultPacks(bank);
  return israeliLocale(locale) ? packs : packs.filter((p) => p !== IL_PACK);
}
