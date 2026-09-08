/**
 * The live page-tool signal.
 *
 * Its whole job is to turn a heartbeat that fires several times a second into
 * an EVENT that fires when the page's tools actually change. Everything below
 * is a way of asking "does it stay quiet when nothing happened, and speak up
 * when something did".
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  browserPageToolsKey,
  noteWebmcpStats,
  useBrowserPageToolsStore,
} from "../browser-page-tools-store";

const KEY = browserPageToolsKey("p1", "hosted");

function epoch(key = KEY) {
  return useBrowserPageToolsStore.getState().epoch[key] ?? 0;
}

beforeEach(() => {
  useBrowserPageToolsStore.setState({ live: {}, epoch: {} });
});

describe("browser page-tools store", () => {
  it("records a signal and moves the epoch once", () => {
    noteWebmcpStats(KEY, { webmcp: { revision: 3, hash: "a", count: 2 } });
    expect(useBrowserPageToolsStore.getState().live[KEY]).toEqual({
      revision: 3,
      hash: "a",
      count: 2,
    });
    expect(epoch()).toBe(1);
  });

  it("stays SILENT on an identical beat", () => {
    // The beat fires several times a second on a page that is not changing. A
    // store write per beat would re-render every subscriber for no reason, and
    // a subscriber that re-read the page on it would be a poll wearing a
    // different hat.
    noteWebmcpStats(KEY, { webmcp: { revision: 3, hash: "a", count: 2 } });
    for (let index = 0; index < 20; index += 1) {
      noteWebmcpStats(KEY, { webmcp: { revision: 3, hash: "a", count: 2 } });
    }
    expect(epoch()).toBe(1);
  });

  it("moves when the HASH changes under an unchanged revision", () => {
    noteWebmcpStats(KEY, { webmcp: { revision: 3, hash: "a", count: 1 } });
    noteWebmcpStats(KEY, { webmcp: { revision: 3, hash: "b", count: 1 } });
    expect(epoch()).toBe(2);
  });

  it("moves when the revision goes BACKWARDS", () => {
    // A daemon that restarted counts up from zero again. Its tool set is a
    // different one however small the number looks, so an epoch keyed on
    // "revision increased" would miss an entire new browser.
    noteWebmcpStats(KEY, { webmcp: { revision: 9, hash: "a", count: 1 } });
    noteWebmcpStats(KEY, { webmcp: { revision: 1, hash: "z", count: 0 } });
    expect(epoch()).toBe(2);
  });

  it("keeps two browsers apart", () => {
    const local = browserPageToolsKey("p1", "local");
    noteWebmcpStats(KEY, { webmcp: { revision: 1, hash: "a", count: 1 } });
    expect(epoch(local)).toBe(0);
    noteWebmcpStats(local, { webmcp: { revision: 1, hash: "a", count: 1 } });
    expect(epoch(local)).toBe(1);
    expect(epoch()).toBe(1);
  });

  it("ignores a beat with no signal rather than blanking the list", () => {
    // Silence is "no news" — a daemon too old to send it, or a garbled beat —
    // and never "no tools". A store that cleared here would empty a list that
    // is still perfectly correct.
    noteWebmcpStats(KEY, { webmcp: { revision: 3, hash: "a", count: 2 } });
    noteWebmcpStats(KEY, undefined);
    noteWebmcpStats(KEY, {});
    noteWebmcpStats(KEY, { webmcp: { revision: "3" } as never });
    expect(epoch()).toBe(1);
    expect(useBrowserPageToolsStore.getState().live[KEY]?.count).toBe(2);
  });

  it("forgets a browser when its stream closes", () => {
    noteWebmcpStats(KEY, { webmcp: { revision: 3, hash: "a", count: 2 } });
    useBrowserPageToolsStore.getState().clear(KEY);
    expect(useBrowserPageToolsStore.getState().live[KEY]).toBeUndefined();
    expect(epoch()).toBe(0);
  });
});

describe("a replacement browser is not the same browser", () => {
  it("moves the epoch when an identical beat comes from a NEW session", () => {
    // A daemon that restarts counts its revision up from zero again, so a fresh
    // session's first beat can be byte-identical to the last one the previous
    // session sent. Treating that as "nothing happened" leaves the pane showing
    // a browser that no longer exists.
    noteWebmcpStats(KEY, { webmcp: { revision: 1, hash: "a", count: 1 } }, "boot-1");
    expect(epoch()).toBe(1);
    noteWebmcpStats(KEY, { webmcp: { revision: 1, hash: "a", count: 1 } }, "boot-1");
    expect(epoch()).toBe(1);
    noteWebmcpStats(KEY, { webmcp: { revision: 1, hash: "a", count: 1 } }, "boot-2");
    expect(epoch()).toBe(2);
  });

  it("still stays silent on repeat beats from the same session", () => {
    for (let index = 0; index < 10; index += 1) {
      noteWebmcpStats(
        KEY,
        { webmcp: { revision: 4, hash: "z", count: 2 } },
        "boot-9",
      );
    }
    expect(epoch()).toBe(1);
  });
});

describe("the signal names the tab it measured", () => {
  it("carries the beat's active tab, so the read that follows can aim at it", () => {
    // The daemon computes `{revision, hash, count}` from the ACTIVE tab, and
    // the page-tools read is a separate request: sent without a tab it
    // observes `@session`, which is a literal key rather than "whichever tab
    // is active". Without this the pane refreshed to the DEFAULT tab's
    // definitions and labelled them live beside a view of another tab.
    noteWebmcpStats(
      KEY,
      { webmcp: { revision: 3, hash: "h", count: 2 }, tabs: { active: "t2" } },
      "boot-1",
    );
    expect(useBrowserPageToolsStore.getState().live[KEY]?.tabId).toBe("t2");
  });

  it("moves the epoch when the ACTIVE TAB changes under an identical signal", () => {
    // Two tabs each showing a page that declares no tools report the same
    // numbers. A different tab is a different page, and the read that follows
    // has to be aimed at the new one — so the equality that decides "nothing
    // happened" has to include the tab.
    const beat = { webmcp: { revision: 0, hash: "empty", count: 0 } };
    noteWebmcpStats(KEY, { ...beat, tabs: { active: "t1" } }, "boot-1");
    expect(epoch()).toBe(1);
    noteWebmcpStats(KEY, { ...beat, tabs: { active: "t1" } }, "boot-1");
    expect(epoch()).toBe(1);
    noteWebmcpStats(KEY, { ...beat, tabs: { active: "t2" } }, "boot-1");
    expect(epoch()).toBe(2);
  });

  it("leaves the tab absent on a daemon whose beat carries no tabs block", () => {
    // Silence is "no news": the read falls back to the behaviour it has always
    // had rather than guessing a tab.
    noteWebmcpStats(KEY, { webmcp: { revision: 1, hash: "a", count: 1 } });
    expect(useBrowserPageToolsStore.getState().live[KEY]?.tabId).toBeUndefined();
  });
});
