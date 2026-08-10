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
  hasStored: true,
  verify: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  clear: vi.fn(),
  subscribers: new Set<() => void>(),
}));
vi.mock("@/lib/local-computer-consent", () => ({
  loadStoredLocalComputerConsent: () =>
    lib.hasStored ? { token: "tok", grantedAt: "now" } : null,
  verifyStoredLocalComputerConsent: () => lib.verify(),
  grantLocalComputerConsent: () => lib.grant(),
  revokeLocalComputerConsent: () => lib.revoke(),
  clearStoredLocalComputerConsent: () => {
    lib.hasStored = false;
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
    lib.hasStored = true;
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
  });
});
