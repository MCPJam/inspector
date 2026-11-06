import { test } from "node:test";
import assert from "node:assert/strict";
import { armPlaygroundClock } from "./playground-clock.mjs";

test("a finished reply without a tool-start remains a miss without blocking the next path", async () => {
  const keys = [
    "document",
    "MutationObserver",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "CSS",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, globalThis[key]]),
  );
  let click;
  globalThis.CSS = { escape: (value) => value };
  const button = {
    disabled: false,
    addEventListener: (_name, fn) => {
      click = fn;
    },
    removeEventListener() {},
  };
  globalThis.document = {
    visibilityState: "visible",
    body: {},
    querySelector: () => button,
    querySelectorAll: () => [],
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (fn) => {
    queueMicrotask(fn);
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  try {
    await armPlaygroundClock(
      { evaluate: (fn, args) => fn(args) },
      "tool",
      "read_note",
    );
    click();
    globalThis.__warmAgentClock.ended();
    const result = await globalThis.__warmAgentClock.result;
    assert.equal(result.failed, true);
    assert.equal(result.ms, 60000);
    assert.ok(Number.isFinite(result.submittedAt));
    await armPlaygroundClock({ evaluate: (fn, args) => fn(args) }, "text");
    click();
    let settled = false;
    globalThis.__warmAgentClock.result.then(() => { settled = true; });
    globalThis.__warmAgentClock.ended();
    await new Promise(setImmediate);
    assert.equal(settled, false, "text still waits for its first paint");
  } finally {
    globalThis.__warmAgentClock?.cancel();
    delete globalThis.__warmAgentClock;
    for (const key of keys) {
      if (previous[key] === undefined) delete globalThis[key];
      else globalThis[key] = previous[key];
    }
  }
});
