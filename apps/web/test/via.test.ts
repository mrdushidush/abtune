// Source tags (`?via=x`): which tags count, how long a device keeps one, and which events it sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAT_EVENTS, VIA_TAGS } from "../src/api-types.ts";
import { setCounting } from "../src/client/state/stats.ts";
import {
  currentVia,
  trackQuizDone,
  trackQuizStart,
  trackVisit,
  VIA_MS,
  viaOf,
} from "../src/client/state/via.ts";
import { isStatEvent } from "../src/server/stats.ts";

class MemoryStore {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

describe("viaOf", () => {
  it("reads the three tags, in any case", () => {
    expect(viaOf("?via=x")).toBe("x");
    expect(viaOf("?via=IG")).toBe("ig");
    expect(viaOf("?a=1&via=tt")).toBe("tt");
    expect(viaOf("?via=%20x%20")).toBe("x");
  });

  it("ignores everything else, so nobody can make up a counter", () => {
    for (const search of ["", "?via=", "?via=fb", "?via=x_open", "?via=xx", "?VIA=x", "?v=x"])
      expect(viaOf(search), search).toBeNull();
  });
});

describe("currentVia", () => {
  const t0 = Date.UTC(2026, 9, 11, 12);

  it("remembers a link's tag for 7 days", () => {
    const store = new MemoryStore();
    expect(currentVia("?via=x", t0, store)).toBe("x");
    expect(currentVia("", t0 + VIA_MS - 1, store)).toBe("x");
    expect(currentVia("", t0 + VIA_MS, store)).toBeNull();
    expect(store.map.size).toBe(0);
    expect(currentVia("", t0 + 1, store)).toBeNull();
  });

  it("lets the last link win, and starts its 7 days again", () => {
    const store = new MemoryStore();
    const t1 = t0 + 3 * 24 * 3600_000;
    currentVia("?via=x", t0, store);
    expect(currentVia("?via=ig", t1, store)).toBe("ig");
    expect(currentVia("", t1 + VIA_MS - 1, store)).toBe("ig");
    // Reopening the same link (the address bar keeps it) restarts the 7 days too.
    currentVia("?via=ig", t1 + VIA_MS - 1, store);
    expect(currentVia("", t1 + VIA_MS + 1, store)).toBe("ig");
  });

  it("drops what it can't trust in storage", () => {
    for (const saved of [
      "not json",
      JSON.stringify({ tag: "fb", at: t0 }),
      JSON.stringify({ tag: "x", at: "yesterday" }),
      JSON.stringify({ tag: "x", at: t0 + 60_000 }),
      "null",
    ]) {
      const store = new MemoryStore();
      store.setItem("abtune.via", saved);
      expect(currentVia("", t0, store), saved).toBeNull();
    }
  });

  it("goes by the URL alone without storage", () => {
    expect(currentVia("?via=tt", t0, null)).toBe("tt");
    expect(currentVia("", t0, null)).toBeNull();
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(currentVia("?via=tt", t0, blocked)).toBe("tt");
    expect(currentVia("", t0, blocked)).toBeNull();
  });
});

describe("the events a tag adds", () => {
  it("has three counters for every tag, and none for anything else", () => {
    for (const tag of VIA_TAGS)
      for (const e of [`via_${tag}_open`, `quiz_start_via_${tag}`, `quiz_done_via_${tag}`])
        expect(isStatEvent(e), e).toBe(true);
    expect(STAT_EVENTS.filter((e) => e.includes("via"))).toHaveLength(VIA_TAGS.length * 3);
    expect(isStatEvent("quiz_done_via_fb")).toBe(false);
  });
});

describe("counting with a tag", () => {
  let sent: Blob[] = [];
  let store: MemoryStore;
  const page = { search: "" };
  const events = async () => {
    const names = await Promise.all(
      sent.map(async (b) => (JSON.parse(await b.text()) as { e: string }).e),
    );
    sent = [];
    return names;
  };

  beforeEach(() => {
    sent = [];
    store = new MemoryStore();
    page.search = "";
    vi.stubGlobal("localStorage", store);
    vi.stubGlobal("location", page);
    vi.stubGlobal("navigator", {
      sendBeacon: (_url: string, body: Blob) => {
        sent.push(body);
        return true;
      },
    });
    vi.useFakeTimers();
    setCounting(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("counts a day's open once, and the quiz with its tag", async () => {
    vi.setSystemTime(new Date("2026-10-11T23:58:00Z"));
    page.search = "?via=x";
    trackVisit();
    trackVisit();
    expect(await events()).toEqual(["via_x_open"]);

    trackQuizStart("seed-1");
    expect(await events()).toEqual(["quiz_start", "quiz_start_via_x"]);

    // Finished after midnight UTC: a new day, so its open is counted first.
    vi.setSystemTime(new Date("2026-10-12T00:01:00Z"));
    trackQuizDone("seed-1");
    expect(await events()).toEqual(["quiz_done", "via_x_open", "quiz_done_via_x"]);
    trackQuizDone("seed-1");
    expect(await events()).toEqual([]);
  });

  it("keeps counting the tag on a later visit without it", async () => {
    vi.setSystemTime(new Date("2026-10-11T10:00:00Z"));
    page.search = "?via=ig";
    trackVisit();
    await events();
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
    page.search = "";
    trackVisit();
    trackQuizStart("seed-2");
    trackQuizDone("seed-2");
    expect(await events()).toEqual([
      "via_ig_open",
      "quiz_start",
      "quiz_start_via_ig",
      "quiz_done",
      "quiz_done_via_ig",
    ]);
  });

  it("adds nothing without a tag", async () => {
    vi.setSystemTime(new Date("2026-10-11T10:00:00Z"));
    page.search = "?via=fb";
    trackVisit();
    trackQuizStart("seed-3");
    trackQuizDone("seed-3");
    expect(await events()).toEqual(["quiz_start", "quiz_done"]);
  });

  it("credits a quiz to the tag it started with, once", async () => {
    vi.setSystemTime(new Date("2026-10-11T10:00:00Z"));
    page.search = "?via=x";
    trackVisit();
    trackQuizStart("seed-4");
    trackQuizDone("seed-4");
    await events();
    // A later Instagram link reopens the saved result: a visit from ig, but the quiz stays x's.
    page.search = "?via=ig";
    trackVisit();
    trackQuizDone("seed-4");
    expect(await events()).toEqual(["via_ig_open"]);
  });

  it("credits a quiz that started without a tag to none, even if one arrives mid-quiz", async () => {
    vi.setSystemTime(new Date("2026-10-11T10:00:00Z"));
    trackQuizStart("seed-5");
    page.search = "?via=tt";
    trackVisit();
    trackQuizDone("seed-5");
    expect(await events()).toEqual(["quiz_start", "via_tt_open", "quiz_done"]);
  });

  it("credits only the quiz that started with the tag", async () => {
    vi.setSystemTime(new Date("2026-10-11T10:00:00Z"));
    page.search = "?via=x";
    trackQuizStart("seed-6");
    trackQuizStart("seed-7");
    await events();
    // seed-6 was replaced by seed-7 before it finished, so only seed-7 is credited.
    trackQuizDone("seed-6");
    trackQuizDone("seed-7");
    expect(await events()).toEqual(["quiz_done", "quiz_done", "quiz_done_via_x"]);
  });
});
