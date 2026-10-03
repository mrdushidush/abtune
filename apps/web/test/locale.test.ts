// Owner decisions of 2026-10-04 on the client: the Israeli pack follows the browser's locale, and
// "Save to Spotify" shows to visitors only once Spotify is set up.
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { defaultPacks } from "@abtune/engine";
import { describe, expect, it } from "vitest";
import type { Health } from "../src/api-types.ts";
import { IL_PACK, israeliLocale, startingPacks } from "../src/client/lib/locale.ts";
import { offerSpotify } from "../src/client/state/spotify.ts";

const questionsDir = fileURLToPath(new URL("../../../data/questions", import.meta.url));

describe("client defaults", async () => {
  const { bank } = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
  if (!bank) throw new Error("seed bank failed to load");

  it("starts with the Israeli pack only for a Hebrew language or an Israeli time zone", () => {
    expect(defaultPacks(bank)).toContain(IL_PACK);
    const us = { languages: ["en-US", "en"], timeZone: "America/New_York" };
    expect(israeliLocale(us)).toBe(false);
    expect(startingPacks(bank, us)).not.toContain(IL_PACK);
    expect(startingPacks(bank, us)).toEqual(defaultPacks(bank).filter((p) => p !== IL_PACK));
    for (const il of [
      { languages: ["he-IL"], timeZone: "UTC" },
      { languages: ["en-US", "iw"], timeZone: undefined },
      { languages: ["en-GB"], timeZone: "Asia/Jerusalem" },
    ]) {
      expect(israeliLocale(il)).toBe(true);
      expect(startingPacks(bank, il)).toEqual(defaultPacks(bank));
    }
    // "hr" (Croatian) and "hel" are not Hebrew.
    expect(israeliLocale({ languages: ["hr", "help"], timeZone: "Europe/Zagreb" })).toBe(false);
  });

  it("offers Spotify once it's set up, and before that only on this machine", () => {
    const health = (configured: boolean) =>
      ({ kind: "ok", health: { spotify: { configured } } as Health }) as const;
    expect(offerSpotify(health(true), "abtune.example.com")).toBe(true);
    expect(offerSpotify(health(false), "abtune.example.com")).toBe(false);
    expect(offerSpotify(health(false), "192.168.1.5")).toBe(false);
    for (const host of ["127.0.0.1", "localhost", "[::1]"])
      expect(offerSpotify(health(false), host)).toBe(true);
    expect(offerSpotify({ kind: "loading" }, "abtune.example.com")).toBe(true);
  });
});
