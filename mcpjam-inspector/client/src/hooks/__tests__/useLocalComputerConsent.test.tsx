import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

/**
 * The hook is now a pure projection of localStorage — no client-side verify,
 * no sequence/self-write guards. These tests pin that projection: reads follow
 * writes from any tab, grant reports storage-failure honestly, and revoke uses
 * a storage-free server primitive so it can't clobber a concurrent grant.
 */
const hosted = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return hosted.value;
  },
}));

// Faithful mock: persist/clear mutate the in-memory token AND fire the
// same-tab subscribers, exactly as the real module's `persist()` does.
const lib = vi.hoisted(() => ({
  storedToken: null as string | null,
  grantToken: "granted-tok",
  persistOk: true,
  mint: vi.fn(),
  revokeServer: vi.fn(),
  subscribers: new Set<() => void>(),
  fire() {
    for (const cb of this.subscribers) cb();
  },
}));
vi.mock("@/lib/local-computer-consent", () => ({
  loadStoredLocalComputerConsent: () =>
    lib.storedToken ? { token: lib.storedToken, grantedAt: "now" } : null,
  mintLocalComputerConsent: async () => {
    const ok = await lib.mint();
    return ok ? { token: lib.grantToken, grantedAt: "now" } : null;
  },
  persistLocalComputerConsent: (c: { token: string }) => {
    if (!lib.persistOk) return false;
    lib.storedToken = c.token;
    lib.fire();
    return true;
  },
  clearStoredLocalComputerConsent: () => {
    lib.storedToken = null;
    lib.fire();
  },
  revokeLocalComputerConsentOnServer: () => lib.revokeServer(),
  subscribeLocalComputerConsent: (cb: () => void) => {
    lib.subscribers.add(cb);
    return () => lib.subscribers.delete(cb);
  },
}));

import { useLocalComputerConsent } from "../useLocalComputerConsent";

describe("useLocalComputerConsent", () => {
  beforeEach(() => {
    hosted.value = false;
    lib.storedToken = null;
    lib.grantToken = "granted-tok";
    lib.persistOk = true;
    lib.mint.mockReset();
    lib.revokeServer.mockReset().mockResolvedValue(undefined);
    lib.subscribers.clear();
  });

  it("hosted: absent, and grant/revoke never touch the server", async () => {
    hosted.value = true;
    lib.storedToken = "leftover"; // even a stray token is ignored hosted
    const { result } = renderHook(() => useLocalComputerConsent());
    expect(result.current.status).toBe("absent");
    expect(result.current.token).toBeNull();
    let ok = true;
    await act(async () => {
      ok = await result.current.grant();
    });
    expect(ok).toBe(false);
    expect(lib.mint).not.toHaveBeenCalled();
  });

  it("projects a stored token as granted on mount", () => {
    lib.storedToken = "tok";
    const { result } = renderHook(() => useLocalComputerConsent());
    expect(result.current.status).toBe("granted");
    expect(result.current.token).toBe("tok");
  });

  it("no stored token → absent", () => {
    const { result } = renderHook(() => useLocalComputerConsent());
    expect(result.current.granted).toBe(false);
    expect(result.current.token).toBeNull();
  });

  it("grant mints, persists, and flips to granted via the storage event", async () => {
    lib.mint.mockResolvedValue(true);
    const { result } = renderHook(() => useLocalComputerConsent());
    let ok = false;
    await act(async () => {
      ok = await result.current.grant();
    });
    expect(ok).toBe(true);
    await waitFor(() => expect(result.current.status).toBe("granted"));
    expect(result.current.token).toBe("granted-tok");
  });

  it("grant returns FALSE and stays absent when persistence fails", async () => {
    // Storage blocked/full: a token nothing can read must never read as granted.
    lib.mint.mockResolvedValue(true);
    lib.persistOk = false;
    const { result } = renderHook(() => useLocalComputerConsent());
    let ok = true;
    await act(async () => {
      ok = await result.current.grant();
    });
    expect(ok).toBe(false);
    expect(result.current.status).toBe("absent");
    expect(result.current.token).toBeNull();
  });

  it("grant returns FALSE when the mint fails", async () => {
    lib.mint.mockResolvedValue(false);
    const { result } = renderHook(() => useLocalComputerConsent());
    let ok = true;
    await act(async () => {
      ok = await result.current.grant();
    });
    expect(ok).toBe(false);
    expect(result.current.status).toBe("absent");
  });

  it("revoke clears storage synchronously and calls the server-only primitive", async () => {
    lib.storedToken = "tok";
    const { result } = renderHook(() => useLocalComputerConsent());
    expect(result.current.status).toBe("granted");
    await act(async () => {
      await result.current.revoke();
    });
    expect(result.current.status).toBe("absent");
    expect(lib.storedToken).toBeNull();
    expect(lib.revokeServer).toHaveBeenCalledTimes(1);
  });

  it("reflects a cross-tab revoke: an external clear event drops to absent", async () => {
    lib.storedToken = "tok";
    const { result } = renderHook(() => useLocalComputerConsent());
    expect(result.current.status).toBe("granted");
    await act(async () => {
      lib.storedToken = null;
      lib.fire(); // another tab cleared consent
    });
    await waitFor(() => expect(result.current.status).toBe("absent"));
  });

  it("reflects a cross-tab grant: an external token event flips to granted", async () => {
    const { result } = renderHook(() => useLocalComputerConsent());
    expect(result.current.status).toBe("absent");
    await act(async () => {
      lib.storedToken = "tok-from-other-tab";
      lib.fire();
    });
    await waitFor(() => expect(result.current.token).toBe("tok-from-other-tab"));
    expect(result.current.status).toBe("granted");
  });
});
