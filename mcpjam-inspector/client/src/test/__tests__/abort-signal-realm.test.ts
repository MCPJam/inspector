import { describe, expect, it } from "vitest";

/**
 * jsdom owns `AbortController` here; Node's undici owns `Request`, and its
 * signal check is a brand check against Node's class. On Node 24 that rejects
 * a jsdom signal outright — and React Router's data router builds exactly that
 * Request on every navigation, so a whole class of router tests silently stops
 * navigating.
 *
 * It reproduced only on CI, which pins Node 24 while local checkouts run 22,
 * and it surfaced as "the click did nothing" rather than as an error. These
 * pin the invariant directly so the next Node bump can't reintroduce it
 * quietly.
 */
describe("the test environment's AbortSignal realm", () => {
  it("hands Request the signal this environment actually creates", () => {
    const controller = new AbortController();
    expect(
      () => new Request("http://localhost/x", { signal: controller.signal })
    ).not.toThrow();
  });

  it("routes Request construction through the realm bridge", () => {
    // Node 22's undici happens to ACCEPT a jsdom signal, so the TypeError this
    // guards against cannot be reproduced on a typical local checkout — only
    // on CI's Node 24. The assertion above therefore passes with or without
    // the bridge here, and would go green on a machine where the bug is fatal.
    //
    // What is assertable on every Node is that the bridge is still installed,
    // which is the thing a cleanup pass would delete.
    expect(Request.name).toBe("BridgedSignalRequest");
  });

  it("leaves the AbortController global to jsdom", () => {
    // Swapping the global for Node's class would fix Request and break
    // `addEventListener(type, fn, { signal })`, which brand-checks the other
    // way — ~80 component tests. The bridge exists so neither side moves.
    const symbols = Object.getOwnPropertySymbols(
      new AbortController().signal
    ).map(String);
    expect(symbols).toContain("Symbol(impl)");
    expect(() => {
      const controller = new AbortController();
      document.createElement("div").addEventListener("click", () => {}, {
        signal: controller.signal,
      });
    }).not.toThrow();
  });

  it("still propagates an abort through to the request", () => {
    // A bridge that dropped the signal would pass the type check and quietly
    // break loader cancellation, which is the only reason the signal is there.
    const controller = new AbortController();
    const request = new Request("http://localhost/x", {
      signal: controller.signal,
    });
    expect(request.signal.aborted).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it("carries an already-aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request("http://localhost/x", {
      signal: controller.signal,
    });
    expect(request.signal.aborted).toBe(true);
  });
});
