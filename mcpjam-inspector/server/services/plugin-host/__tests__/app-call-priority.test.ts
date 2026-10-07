import { describe, expect, it } from "vitest";
import { createAppCallYield, runAppCall } from "../app-call-priority.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => new Promise((done) => setTimeout(done, 0));

describe("App calls before activation work", () => {
  it("waits only while an App call on the same instance is in flight", async () => {
    const call = deferred();
    const running = runAppCall("token", () => call.promise);
    let resumed = false;
    const waiting = createAppCallYield("token")(
      new AbortController().signal,
    ).then(() => {
      resumed = true;
    });
    // Another App's calls never hold this one up.
    await createAppCallYield("other")(new AbortController().signal);
    await flush();
    expect(resumed).toBe(false);
    call.resolve();
    await running;
    await waiting;
    expect(resumed).toBe(true);
    // Nothing in flight: no wait at all.
    await createAppCallYield("token")(new AbortController().signal);
  });

  it("spends one bounded budget per activation request", async () => {
    const call = deferred();
    const running = runAppCall("busy", () => call.promise);
    const yieldToApp = createAppCallYield("busy", 20);
    const started = Date.now();
    await yieldToApp(new AbortController().signal);
    await yieldToApp(new AbortController().signal);
    expect(Date.now() - started).toBeLessThan(200);
    call.resolve();
    await running;
  });

  it("stops waiting when the activation request is cancelled", async () => {
    const call = deferred();
    const running = runAppCall("cancel", () => call.promise);
    const controller = new AbortController();
    const waiting = createAppCallYield("cancel")(controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    call.resolve();
    await running;
  });

  it("releases the instance even when the App call fails", async () => {
    await expect(
      runAppCall("failing", async () => {
        throw new Error("tool failed");
      }),
    ).rejects.toThrow("tool failed");
    const started = Date.now();
    await createAppCallYield("failing", 5_000)(new AbortController().signal);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
