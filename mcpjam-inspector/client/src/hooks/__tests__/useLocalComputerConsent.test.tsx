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

const lib = vi.hoisted(() => ({
  storedToken: "tok" as string | null,
  verify: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  clear: vi.fn(),
  subscribers: new Set<() => void>(),
  fireSubscribers() {
    for (const cb of this.subscribers) cb();
  },
}));
vi.mock("@/lib/local-computer-consent", () => ({
  loadStoredLocalComputerConsent: () =>
    lib.storedToken ? { token: lib.storedToken, grantedAt: "now" } : null,
  verifyStoredLocalComputerConsent: () => lib.verify(),
  grantLocalComputerConsent: () => lib.grant(),
  revokeLocalComputerConsent: () => lib.revoke(),
  clearStoredLocalComputerConsent: () => {
    lib.storedToken = null;
    lib.clear();
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
    lib.verify.mockReset();
    lib.grant.mockReset();
    lib.revoke.mockReset();
    lib.clear.mockReset();
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

  it("grant success sets granted immediately", async () => {
    lib.verify.mockResolvedValue(false);
    lib.grant.mockResolvedValue(true);
    const { result } = renderHook(() => useLocalComputerConsent());
    await waitFor(() => expect(result.current.status).toBe("absent"));
    await act(async () => {
      const ok = await result.current.grant();
      expect(ok).toBe(true);
    });
    expect(result.current.status).toBe("granted");
    expect(result.current.token).toBe("tok");
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
    // grant claims its sequence before awaiting; a revoke that starts after
    // gets a higher sequence and wins even though the grant resolves later.
    // The stale grant must also undo its persisted token (clear + server
    // revoke) so the revoke stays final.
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
    // Revoke starts AFTER grant claimed its slot but BEFORE grant resolves.
    await act(async () => {
      await result.current.revoke();
    });
    expect(result.current.status).toBe("absent");

    // The grant server call finally succeeds — but it's stale.
    await act(async () => {
      resolveGrant(true);
      await grantResult;
    });
    expect(await grantResult).toBe(false);
    expect(result.current.status).toBe("absent");
    // The stale grant undid its own persistence via the server revoke.
    expect(lib.revoke).toHaveBeenCalledTimes(2); // explicit revoke + stale undo
  });
});
