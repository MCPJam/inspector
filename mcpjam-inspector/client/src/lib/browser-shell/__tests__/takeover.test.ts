import { describe, expect, it, vi } from "vitest";
import { TakeoverCoordinator } from "../takeover";
import type { InteractionAnchor } from "../../../../../shared/browser-pane-command";

const ANCHOR: InteractionAnchor = {
  tabId: "t1",
  url: "https://a.test/",
  navCounter: 4,
};

/** A promise the test releases by hand, so an acquire can be held open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("when the browser is already ours", () => {
  it("delivers without a round trip", async () => {
    const acquire = vi.fn();
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => true,
      acquire: acquire as never,
    });
    await expect(coordinator.gesture({ payload: "click" })).resolves.toEqual({
      status: "deliver",
      payload: "click",
    });
    // The overwhelmingly common case once somebody is driving; it must cost
    // nothing.
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe("taking the browser", () => {
  it("acquires, then delivers the gesture that asked for it", async () => {
    let holding = false;
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => holding,
      acquire: async () => {
        holding = true;
        return { ok: true };
      },
    });
    await expect(coordinator.gesture({ payload: "click" })).resolves.toEqual({
      status: "deliver",
      payload: "click",
    });
  });

  it("runs ONE acquire for a burst", async () => {
    // A scroll is a dozen wheel events; each starting its own acquire would
    // ask the server a dozen times for a lease it has already granted.
    let holding = false;
    const gate = deferred<void>();
    const acquire = vi.fn(async () => {
      await gate.promise;
      holding = true;
      return { ok: true as const };
    });
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => holding,
      acquire,
    });

    const first = coordinator.gesture({ payload: "wheel-1" });
    const rest = [2, 3, 4, 5].map((n) =>
      coordinator.gesture({ payload: `wheel-${n}` }),
    );
    gate.resolve();
    const results = await Promise.all([first, ...rest]);

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual({ status: "deliver", payload: "wheel-1" });
    // The later ones proceed on their own merit once the lease is ours.
    for (const result of results.slice(1)) {
      expect(result).toMatchObject({ status: "deliver" });
    }
  });

  it("drops a JOINED click whose page moved during the acquire", async () => {
    // A gesture that merely joined somebody else's acquire captured its anchor
    // before the same round trip, so it is exactly as stale as the one that
    // started it. Delivered unchecked, it is a click landing on whatever the
    // page navigated to while the lease was being taken.
    const gate = deferred<void>();
    let holding = false;
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => holding,
      acquire: async () => {
        await gate.promise;
        holding = true;
        return { ok: true as const };
      },
      // The page has moved on: a different nav counter from the one both
      // gestures were aimed at.
      readAnchor: async () => ({
        tabId: "t1",
        url: "https://elsewhere.test/",
        navCounter: 9,
      }),
    });

    const anchor = { tabId: "t1", url: "https://a.test/", navCounter: 4 };
    const first = coordinator.gesture({ payload: "click-1", anchor });
    const joined = coordinator.gesture({ payload: "click-2", anchor });
    gate.resolve();

    expect(await first).toEqual({ status: "dropped", reason: "page_changed" });
    expect(await joined).toEqual({ status: "dropped", reason: "page_changed" });
  });

  it("reports coalesced for a gesture whose acquire was refused", async () => {
    const gate = deferred<void>();
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => false,
      acquire: async () => {
        await gate.promise;
        return { ok: false as const, holder: { kind: "human" as const } };
      },
    });
    const first = coordinator.gesture({ payload: "a" });
    const second = coordinator.gesture({ payload: "b" });
    gate.resolve();
    expect(await first).toMatchObject({ status: "refused" });
    expect(await second).toEqual({ status: "coalesced" });
  });
});

describe("when somebody else has it", () => {
  it("refuses and names them", async () => {
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => false,
      acquire: async () => ({
        ok: false,
        holder: { kind: "script", id: "cdp" },
      }),
    });
    await expect(coordinator.gesture({ payload: "click" })).resolves.toEqual({
      status: "refused",
      holder: { kind: "script", id: "cdp" },
    });
  });

  it("reports a failed acquire as its own thing", async () => {
    // Offline, a 500, a closed session: a person can retry, and telling them
    // somebody else has the browser would send them looking for a holder who
    // does not exist.
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => false,
      acquire: async () => {
        throw new Error("Failed to fetch");
      },
    });
    await expect(coordinator.gesture({ payload: "click" })).resolves.toEqual({
      status: "failed",
      detail: "Failed to fetch",
    });
  });
});

describe("the anchor", () => {
  it("delivers when the page has not moved", async () => {
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => false,
      acquire: async () => ({ ok: true }),
      readAnchor: async () => ({ ...ANCHOR }),
    });
    await expect(
      coordinator.gesture({ payload: "click", anchor: ANCHOR }),
    ).resolves.toEqual({ status: "deliver", payload: "click" });
  });

  it("drops a click aimed at a page that navigated during the acquire", async () => {
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => false,
      acquire: async () => ({ ok: true }),
      readAnchor: async () => ({ ...ANCHOR, url: "https://b.test/" }),
    });
    await expect(
      coordinator.gesture({ payload: "click", anchor: ANCHOR }),
    ).resolves.toEqual({ status: "dropped", reason: "page_changed" });
  });

  it("drops rather than guessing when the page cannot be read", async () => {
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => false,
      acquire: async () => ({ ok: true }),
      readAnchor: async () => null,
    });
    await expect(
      coordinator.gesture({ payload: "click", anchor: ANCHOR }),
    ).resolves.toMatchObject({ status: "dropped" });
  });

  it("drops when a read throws", async () => {
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => false,
      acquire: async () => ({ ok: true }),
      readAnchor: async () => {
        throw new Error("offline");
      },
    });
    await expect(
      coordinator.gesture({ payload: "click", anchor: ANCHOR }),
    ).resolves.toMatchObject({ status: "dropped" });
  });

  it("delivers a gesture with nothing to verify", async () => {
    // A keystroke is aimed at whatever has focus; a navigation is aimed at a
    // URL. Only a click carries an anchor.
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => false,
      acquire: async () => ({ ok: true }),
      readAnchor: async () => null,
    });
    await expect(coordinator.gesture({ payload: "key" })).resolves.toEqual({
      status: "deliver",
      payload: "key",
    });
  });

  it("drops an anchored gesture when the pane cannot check at all", async () => {
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => false,
      acquire: async () => ({ ok: true }),
    });
    await expect(
      coordinator.gesture({ payload: "click", anchor: ANCHOR }),
    ).resolves.toMatchObject({ status: "dropped" });
  });
});

describe("acquiring", () => {
  it("reports the transitional state, and clears it after a failure", async () => {
    const gate = deferred<void>();
    const coordinator = new TakeoverCoordinator<string>({
      isHolding: () => false,
      acquire: async () => {
        await gate.promise;
        throw new Error("nope");
      },
    });
    expect(coordinator.acquiring).toBe(false);
    const running = coordinator.gesture({ payload: "click" });
    expect(coordinator.acquiring).toBe(true);
    gate.resolve();
    await running;
    expect(coordinator.acquiring).toBe(false);
  });
});
