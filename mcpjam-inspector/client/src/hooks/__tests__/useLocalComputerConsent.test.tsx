import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

/**
 * The out-of-order guard: verify/grant/revoke resolve asynchronously and can
 * complete in any order, but only the LATEST-initiated op may write status.
 * The load-bearing case is a slow stale verify landing after a revoke — it
 * must NOT restore `granted`.
 */
const hosted = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return hosted.value;
  },
}));

// FAITHFUL mock: the real module's grant persists a token AND
// `clearStoredLocalComputerConsent` both reach `persist()`, which dispatches
// the same-tab consent event SYNCHRONOUSLY. Reproducing that side effect is
// what exercises the hook's re-entrant refresh — without it, a whole class of
// self-supersede bugs passes silently.
const lib = vi.hoisted(() => ({
  storedToken: "tok" as string | null,
  grantToken: "granted-tok",
  verify: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  subscribers: new Set<() => void>(),
  fireSubscribers() {
    for (const cb of this.subscribers) cb();
  },
}));
vi.mock("@/lib/local-computer-consent", () => ({
  loadStoredLocalComputerConsent: () =>
    lib.storedToken ? { token: lib.storedToken, grantedAt: "now" } : null,
  verifyStoredLocalComputerConsent: () => lib.verify(),
  // mint = network only, NO persist, NO event (matches the real split).
  mintLocalComputerConsent: async () => {
    const ok = await lib.grant();
    return ok ? { token: lib.grantToken, grantedAt: "now" } : null;
  },
  // persist = synchronous storage write + same-tab event.
  persistLocalComputerConsent: (c: { token: string }) => {
    lib.storedToken = c.token;
    lib.fireSubscribers();
    return true;
  },
  revokeLocalComputerConsent: () => lib.revoke(),
  clearStoredLocalComputerConsent: () => {
    lib.storedToken = null; // persist(null)
    lib.fireSubscribers(); // persist(null)'s synchronous same-tab event
  },
  subscribeLocalComputerConsent: (cb: () => void) => {
    lib.subscribers.add(cb);
    return () => lib.subscribers.delete(cb);
  },
}));

import { useLocalComputerConsent } from "../useLocalComputerConsent";

describe("useLocalComputerConsent", () => {
  beforeEach(() => {
    hosted.value = false;
    lib.storedToken = "tok";
    lib.grantToken = "granted-tok";
    lib.verify.mockReset();
    lib.grant.mockReset();
    lib.revoke.mockReset();
    lib.subscribers.clear();
  });

  it("hosted: absent forever, never calls the server", () => {
    hosted.value = true;
    const { result } = renderHook(() => useLocalComputerConsent());
    expect(result.current.status).toBe("absent");
    expect(lib.verify).not.toHaveBeenCalled();
  });

  it("verifies a stored token on mount → granted", async () => {
    lib.verify.mockResolvedValue(true);
    const { result } = renderHook(() => useLocalComputerConsent());
    await waitFor(() => expect(result.current.status).toBe("granted"));
    expect(result.current.token).toBe("tok");
  });

  it("a stale verify resolving AFTER revoke does NOT restore granted", async () => {
    // Mount verify hangs; we revoke while it's in flight, then it resolves
    // true. The op-sequence guard must drop that stale result.
    let resolveVerify: (v: boolean) => void = () => {};
    lib.verify.mockReturnValue(
      new Promise<boolean>((r) => {
        resolveVerify = r;
      }),
    );
    lib.revoke.mockResolvedValue(undefined);

    const { result } = renderHook(() => useLocalComputerConsent());
    await act(async () => {
      await result.current.revoke();
    });
    expect(result.current.status).toBe("absent");

    // The mount's verify finally answers "valid" — must be ignored.
    await act(async () => {
      resolveVerify(true);
    });
    expect(result.current.status).toBe("absent");
  });

  it("grant succeeds despite its OWN persistence event (self-write guard)", async () => {
    // The regression this pins: the real grant dispatches a same-tab event
    // that re-enters refresh() and bumps the sequence. Without the self-write
    // guard, grant classifies itself as superseded, clears its own token, and
    // returns false — making consent impossible to grant.
    lib.storedToken = null; // start ungranted
    lib.verify.mockResolvedValue(false);
    lib.grant.mockResolvedValue(true);
    const { result } = renderHook(() => useLocalComputerConsent());
    await waitFor(() => expect(result.current.status).toBe("absent"));
    let ok = false;
    await act(async () => {
      ok = await result.current.grant();
    });
    expect(ok).toBe(true);
    expect(result.current.status).toBe("granted");
    expect(result.current.token).toBe("granted-tok");
    // Its own persistence event must NOT have triggered a self-revoke.
    expect(lib.revoke).not.toHaveBeenCalled();
    expect(lib.storedToken).toBe("granted-tok");
  });

  it("a token rotation that keeps status 'granted' updates the returned token", async () => {
    // Tab B rotates the capability while this hook is already granted. Status
    // stays "granted" but the returned token MUST follow — reading it from
    // storage at render time would go stale when React bails on same-value
    // status.
    lib.verify.mockResolvedValue(true);
    const { result } = renderHook(() => useLocalComputerConsent());
    await waitFor(() => expect(result.current.token).toBe("tok"));

    lib.storedToken = "tok-B";
    await act(async () => {
      lib.fireSubscribers();
    });
    await waitFor(() => expect(result.current.token).toBe("tok-B"));
    expect(result.current.status).toBe("granted");
  });

  it("a storage event carrying an invalidated token drops status to absent", async () => {
    // The docstring'd re-verify path: a subscriber fires, verify now says no.
    lib.verify.mockResolvedValueOnce(true).mockResolvedValue(false);
    const { result } = renderHook(() => useLocalComputerConsent());
    await waitFor(() => expect(result.current.status).toBe("granted"));

    await act(async () => {
      lib.fireSubscribers();
    });
    await waitFor(() => expect(result.current.status).toBe("absent"));
    expect(result.current.token).toBeNull();
  });

  it("a later revoke beats an EARLIER in-flight grant (claim-before-await)", async () => {
    // grant claims its sequence before minting; a revoke that starts after
    // gets a higher sequence and wins even though the mint resolves later.
    // The stale grant never persists, and drops the just-minted server
    // capability so the revoke stays final.
    lib.verify.mockResolvedValue(false);
    let resolveGrant: (ok: boolean) => void = () => {};
    lib.grant.mockReturnValue(
      new Promise<boolean>((r) => {
        resolveGrant = r;
      }),
    );
    lib.revoke.mockResolvedValue(undefined);

    const { result } = renderHook(() => useLocalComputerConsent());
    await waitFor(() => expect(result.current.status).toBe("absent"));

    let grantResult: Promise<boolean> = Promise.resolve(false);
    act(() => {
      grantResult = result.current.grant();
    });
    // Revoke starts AFTER grant claimed its slot but BEFORE the mint resolves.
    await act(async () => {
      await result.current.revoke();
    });
    expect(result.current.status).toBe("absent");

    // The mint finally succeeds — but it's stale.
    await act(async () => {
      resolveGrant(true);
      await grantResult;
    });
    expect(await grantResult).toBe(false);
    expect(result.current.status).toBe("absent");
    expect(lib.storedToken).toBeNull(); // never persisted
    // explicit revoke + the stale grant dropping its minted capability.
    expect(lib.revoke).toHaveBeenCalledTimes(2);
  });

  it("an EXTERNAL revoke during a pending grant is not overwritten (mint wait is unguarded)", async () => {
    // The round-4 regression: guarding the whole grant network wait also hid
    // genuine cross-tab events. Now only the synchronous persist is guarded, so
    // an external revoke arriving mid-mint advances the sequence and the
    // completing grant discards itself.
    lib.storedToken = null;
    lib.verify.mockResolvedValue(false);
    let resolveMint: (ok: boolean) => void = () => {};
    lib.grant.mockReturnValue(
      new Promise<boolean>((r) => {
        resolveMint = r;
      }),
    );
    lib.revoke.mockResolvedValue(undefined);

    const { result } = renderHook(() => useLocalComputerConsent());
    await waitFor(() => expect(result.current.status).toBe("absent"));

    let grantResult: Promise<boolean> = Promise.resolve(false);
    act(() => {
      grantResult = result.current.grant();
    });
    // Another tab revokes while the mint is in flight — its storage clear fires
    // the same-tab subscribers here. The unguarded mint await lets it through.
    await act(async () => {
      lib.storedToken = null;
      lib.fireSubscribers();
    });

    await act(async () => {
      resolveMint(true);
      await grantResult;
    });
    expect(await grantResult).toBe(false);
    expect(result.current.status).toBe("absent");
    expect(lib.storedToken).toBeNull();
    expect(lib.revoke).toHaveBeenCalled(); // dropped the minted capability
  });
});
