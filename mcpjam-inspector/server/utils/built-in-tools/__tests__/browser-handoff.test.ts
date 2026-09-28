import { describe, expect, it, vi } from "vitest";
import {
  parkForHandoff,
  resumedMessage,
  stillHeldMessage,
  waitForHandoff,
  type HandoffLeaseRead,
  type HandoffWaitDeps,
} from "../browser-handoff";

/**
 * A hand-driven clock, so five minutes of budget costs no real seconds.
 *
 * `sleep` advances it rather than waiting, which is what makes "the wait ran
 * out" a test rather than something to trust.
 */
function harness(reads: HandoffLeaseRead[], over: Partial<HandoffWaitDeps> = {}) {
  let clock = 1_000;
  const waiting: Array<{ waiting: boolean; holder?: { kind: string } }> = [];
  let index = 0;
  const deps: HandoffWaitDeps = {
    readLease: async () => reads[Math.min(index++, reads.length - 1)]!,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    onWaiting: (state) => waiting.push(state),
    pollMs: 1_000,
    maxWaitMs: 10_000,
    ...over,
  };
  return { deps, waiting, reads: () => index };
}

const HELD: HandoffLeaseRead = { held: true, holder: { kind: "human" } };
const FREE: HandoffLeaseRead = { held: false };

describe("waiting for the browser to come back", () => {
  it("returns immediately when nobody is holding it", async () => {
    const { deps, waiting } = harness([FREE]);
    await expect(waitForHandoff(deps)).resolves.toMatchObject({
      status: "released",
    });
    // Handback can land between the rejected action and the first lease read.
    expect(waiting).toEqual([{ waiting: false, resumed: true, holder: { kind: "human" } }]);
  });

  it("parks until the person hands back, and says how long it waited", async () => {
    const { deps } = harness([HELD, HELD, HELD, FREE]);
    const outcome = await waitForHandoff(deps);
    expect(outcome).toMatchObject({ status: "released" });
    expect(outcome).toHaveProperty("waitedMs", 3_000);
  });

  it("announces the wait once, and clears it when it ends", async () => {
    // Without this the only difference between "parked behind a person" and
    // "hung" is that one of them eventually finishes.
    const { deps, waiting } = harness([HELD, HELD, FREE]);
    await waitForHandoff(deps);
    expect(waiting).toEqual([
      { waiting: true, holder: { kind: "human" } },
      { waiting: false, resumed: true, holder: { kind: "human" } },
    ]);
  });

  it("gives up when the budget runs out, and names the holder", async () => {
    const { deps } = harness([HELD]);
    const outcome = await waitForHandoff(deps);
    expect(outcome).toMatchObject({
      status: "still_held",
      holder: { kind: "human" },
    });
  });

  it("clears the waiting state even when it gave up", async () => {
    const { deps, waiting } = harness([HELD]);
    await waitForHandoff(deps);
    expect(waiting.at(-1)).toMatchObject({ waiting: false });
  });
});

describe("stopping", () => {
  it("reports a cancellation rather than a failure when the turn is stopped", async () => {
    const controller = new AbortController();
    const { deps } = harness([HELD, HELD, FREE], {
      sleep: async () => {
        controller.abort();
      },
    });
    await expect(waitForHandoff(deps, controller.signal)).resolves.toEqual({
      status: "cancelled",
    });
  });

  it("does not even read the lease when already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const readLease = vi.fn(async () => FREE);
    const { deps } = harness([FREE], { readLease });
    await expect(waitForHandoff(deps, controller.signal)).resolves.toEqual({
      status: "cancelled",
    });
    expect(readLease).not.toHaveBeenCalled();
  });

  it("clears the waiting state on a cancellation", async () => {
    // A spinner nothing will ever clear is worse than no spinner.
    const controller = new AbortController();
    let calls = 0;
    const { deps, waiting } = harness([HELD], {
      sleep: async () => {
        if (calls++ === 0) controller.abort();
      },
    });
    await waitForHandoff(deps, controller.signal);
    expect(waiting.at(-1)).toMatchObject({ waiting: false });
  });
});

describe("when the lease cannot be read", () => {
  it("stops rather than polling an unreachable daemon for minutes", async () => {
    const { deps } = harness([{ held: "unknown" }]);
    await expect(waitForHandoff(deps)).resolves.toEqual({ status: "unknown" });
  });

  it("treats a thrown read as unknown too", async () => {
    const { deps } = harness([FREE], {
      readLease: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(waitForHandoff(deps)).resolves.toEqual({ status: "unknown" });
  });
});

describe("what the model is told", () => {
  it("says plainly that the action never ran", () => {
    // A model that reads "ok" assumes its click landed; one told only that the
    // page changed assumes it ran and then something moved. Same wrong step.
    const message = resumedMessage(42_000);
    expect(message).toContain("NOT PERFORMED");
    expect(message).toContain("42s");
    expect(message).toMatch(/decide your next action/i);
  });

  it("rounds a sub-second wait up rather than saying zero", () => {
    expect(resumedMessage(120)).toContain("1s");
  });

  it("tells the model not to retry a script holder", () => {
    expect(stillHeldMessage({ kind: "script" })).toMatch(/not something you can wait out/i);
    expect(stillHeldMessage({ kind: "human" })).toMatch(/retrying\s+will not free it/i);
  });
});


describe("parkForHandoff — the whole handoff, end to end", () => {
  /** A lease that is held for `holdFor` reads, then free. */
  function leasingClient(holdFor: number) {
    let reads = 0;
    return {
      reads: () => reads,
      client: {
        lease: async () =>
          reads++ < holdFor
            ? { state: "held", holder: "pane-1", holderKind: "human" }
            : { state: "free" },
      },
    };
  }

  const noSleep = async () => {};

  it("hands the abort signal to the lease read", async () => {
    // The poll sits on this call for as long as somebody holds the browser.
    // A read that could not be aborted left a cancelled turn's request pending
    // until the client timeout, long after anything wanted the answer.
    const seen: Array<AbortSignal | undefined> = [];
    const controller = new AbortController();
    await parkForHandoff({
      client: {
        lease: async (options?: { signal?: AbortSignal }) => {
          seen.push(options?.signal);
          return { state: "free" as const };
        },
      },
      observe: async () => ({ ok: true, output: { url: "https://a.test/" } }),
      signal: controller.signal,
      sleep: noSleep,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(controller.signal);
  });

  it("still reads a lease from a client that takes no options", async () => {
    // Every implementation is free to ignore the signal; none may be broken by
    // being offered one.
    const { client } = leasingClient(0);
    const outcome = await parkForHandoff({
      client,
      observe: async () => ({ ok: true, output: { url: "https://a.test/" } }),
      sleep: noSleep,
    });
    expect(outcome.error).toContain("YOUR ACTION WAS NOT PERFORMED");
  });

  it("comes back with a FRESH observation, not the blocked action's result", async () => {
    const { client } = leasingClient(2);
    const observe = vi.fn(async () => ({
      ok: true,
      output: { url: "https://after-login.test/" },
      stateToken: { tabId: "t1", navCounter: 9 },
    }));
    const outcome = await parkForHandoff({
      client,
      observe,
      sleep: noSleep,
      pollMs: 0,
    });

    // Taken AFTER the release: keeping the turn's existing observation would
    // have the model re-decide from a picture taken before somebody signed in.
    expect(observe).toHaveBeenCalledTimes(1);
    expect(outcome.output).toEqual({ url: "https://after-login.test/" });
    expect(outcome.stateToken).toEqual({ tabId: "t1", navCounter: 9 });
  });

  it("never reports success, so the model cannot think its action landed", () => {
    // The whole point of the resumption: nothing was performed.
    expect(resumedMessage(1_000)).toContain("NOT PERFORMED");
  });

  it("says so when the page cannot be read after the handoff", async () => {
    const { client } = leasingClient(1);
    const outcome = await parkForHandoff({
      client,
      observe: async () => ({ ok: false, error: "unknown_tab: t1" }),
      sleep: noSleep,
      pollMs: 0,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("browser_resumed");
    expect(outcome.error).toContain("unknown_tab: t1");
  });

  it("does not observe at all when the wait ran out", async () => {
    const observe = vi.fn(async () => ({ ok: true, output: {} }));
    const outcome = await parkForHandoff({
      client: {
        lease: async () => ({
          state: "held",
          holder: "pane-1",
          holderKind: "human",
        }),
      },
      observe,
      sleep: noSleep,
      pollMs: 0,
      maxWaitMs: 0,
    });
    expect(observe).not.toHaveBeenCalled();
    expect(outcome.error).toContain("browser_in_use");
  });

  it("does not observe when the turn was stopped", async () => {
    // "Returning control must not create work after the task has finished."
    const controller = new AbortController();
    controller.abort();
    const observe = vi.fn(async () => ({ ok: true, output: {} }));
    const outcome = await parkForHandoff({
      client: { lease: async () => ({ state: "free" }) },
      observe,
      sleep: noSleep,
      signal: controller.signal,
    });
    expect(observe).not.toHaveBeenCalled();
    expect(outcome.error).toContain("browser_cancelled");
  });

  it("falls back to the old refusal on an engine with no lease to poll", async () => {
    const observe = vi.fn(async () => ({ ok: true, output: {} }));
    const outcome = await parkForHandoff({ client: {}, observe });
    expect(observe).not.toHaveBeenCalled();
    expect(outcome.error).toContain("browser_in_use");
  });

  it("reports a browser that stopped answering as unavailable, not as resumed", async () => {
    const outcome = await parkForHandoff({
      client: {
        lease: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
      observe: async () => ({ ok: true, output: {} }),
      sleep: noSleep,
    });
    expect(outcome.error).toContain("browser_unavailable");
  });

  it("reads a script holder as one, and says not to wait it out", async () => {
    const outcome = await parkForHandoff({
      client: {
        lease: async () => ({
          state: "held",
          holder: "cdp",
          holderKind: "script",
        }),
      },
      observe: async () => ({ ok: true, output: {} }),
      sleep: noSleep,
      maxWaitMs: 0,
    });
    expect(outcome.error).toMatch(/script/i);
  });
});
