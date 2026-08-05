import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

vi.mock("@/lib/apis/web/api-keys", () => ({
  listApiKeys: (...args: unknown[]) => mocks.listApiKeys(...args),
  createApiKey: (...args: unknown[]) => mocks.createApiKey(...args),
  revokeApiKey: (...args: unknown[]) => mocks.revokeApiKey(...args),
}));

import { useApiKeys } from "../useApiKeys";

const KEY = { id: "key-1", name: "ci", obfuscated_value: "sk_...abcd" };

beforeEach(() => {
  mocks.listApiKeys.mockReset().mockResolvedValue([KEY]);
  mocks.createApiKey.mockReset();
  mocks.revokeApiKey.mockReset().mockResolvedValue(undefined);
});

describe("useApiKeys", () => {
  it("lists keys when enabled", async () => {
    const { result } = renderHook(() => useApiKeys({ enabled: true }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.keys).toEqual([KEY]);
    expect(result.current.error).toBeNull();
  });

  it("stays idle when disabled — no request, no loading, no error", async () => {
    // /ci-evals is guest-reachable and /api/web/api-keys requires a session
    // bearer; a guaranteed 401 is worse than not asking.
    const { result } = renderHook(() => useApiKeys({ enabled: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.listApiKeys).not.toHaveBeenCalled();
    expect(result.current.keys).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("returns list failures instead of toasting them", async () => {
    mocks.listApiKeys.mockRejectedValue(new Error("Request failed (500)"));
    const { result } = renderHook(() => useApiKeys({ enabled: true }));

    await waitFor(() =>
      expect(result.current.error).toBe("Request failed (500)"),
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.keys).toEqual([]);
  });

  it("clears a stale error on a successful refresh", async () => {
    mocks.listApiKeys.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useApiKeys({ enabled: true }));

    await waitFor(() => expect(result.current.error).toBe("boom"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.keys).toEqual([KEY]);
  });

  it("resolves create with the one-time value and refreshes the list", async () => {
    mocks.listApiKeys.mockResolvedValueOnce([]).mockResolvedValue([KEY]);
    mocks.createApiKey.mockResolvedValue({
      ...KEY,
      value: "mcpjam-test-plaintext-key",
    });

    const { result } = renderHook(() => useApiKeys({ enabled: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.keys).toEqual([]);

    let created: { value: string } | undefined;
    await act(async () => {
      created = await result.current.create({
        name: "ci",
        organizationId: "org-1",
      });
    });

    expect(created?.value).toBe("mcpjam-test-plaintext-key");
    await waitFor(() => expect(result.current.keys).toEqual([KEY]));
  });

  it("rejects create failures rather than swallowing them into state", async () => {
    // Callers differ on presentation — the settings page toasts, the eval
    // quickstart renders inline — so the hook must not choose for them.
    mocks.createApiKey.mockRejectedValue(new Error("not ready"));
    const { result } = renderHook(() => useApiKeys({ enabled: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(
        result.current.create({ name: "ci", organizationId: "org-1" }),
      ).rejects.toThrow("not ready");
    });
    await waitFor(() => expect(result.current.isCreating).toBe(false));
  });

  it("revokes and refreshes", async () => {
    const { result } = renderHook(() => useApiKeys({ enabled: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mocks.listApiKeys.mockResolvedValue([]);
    await act(async () => {
      await result.current.revoke("key-1");
    });

    expect(mocks.revokeApiKey).toHaveBeenCalledWith("key-1");
    await waitFor(() => expect(result.current.keys).toEqual([]));
  });

  it("does not let a slow mount list overwrite the post-create list", async () => {
    // The mount request resolves AFTER the refresh that follows `create`.
    // Without a generation guard, its older (empty) list wins and the key the
    // user just minted vanishes from the UI until something refreshes again.
    const NEW_KEY = { id: "key-2", name: "fresh", obfuscated_value: "…wxyz" };
    let releaseMountList: (value: (typeof KEY)[]) => void = () => {};
    mocks.listApiKeys
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseMountList = resolve as typeof releaseMountList;
          }),
      )
      .mockResolvedValue([NEW_KEY]);
    mocks.createApiKey.mockResolvedValue({
      ...NEW_KEY,
      value: "mcpjam-test-plaintext-key",
    });

    const { result } = renderHook(() => useApiKeys({ enabled: true }));

    await act(async () => {
      await result.current.create({ name: "fresh", organizationId: "org-1" });
    });
    await waitFor(() => expect(result.current.keys).toEqual([NEW_KEY]));

    // …now the stale mount request finally lands.
    await act(async () => {
      releaseMountList([]);
      await Promise.resolve();
    });

    expect(result.current.keys).toEqual([NEW_KEY]);
    // …and it must not clear the spinner state the newest request owns either.
    expect(result.current.loading).toBe(false);
  });

  it("does not refresh after a mutation that finishes post-sign-out", async () => {
    // `create` ends in a refresh, and that runs AFTER its own round trip — by
    // which point the user may have signed out. A refresh closed over
    // `enabled: true` would fire a guaranteed-401 list request and, bumping the
    // generation last, would be the one allowed to commit — restoring the
    // previous session's keys for a signed-out viewer.
    let releaseCreate: (value: unknown) => void = () => {};
    mocks.createApiKey.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreate = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      ({ enabled }) => useApiKeys({ enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.keys).toEqual([KEY]));

    const pending = result.current.create({
      name: "ci",
      organizationId: "org-1",
    });

    // Sign out mid-flight, then let the create land.
    rerender({ enabled: false });
    const callsBefore = mocks.listApiKeys.mock.calls.length;
    await act(async () => {
      releaseCreate({ ...KEY, value: "mcpjam-test-plaintext-key" });
      await pending;
    });

    expect(mocks.listApiKeys.mock.calls.length).toBe(callsBefore);
    expect(result.current.keys).toEqual([]);
  });

  it("drops an in-flight list when the hook goes disabled", async () => {
    // Sign-out mid-flight: the response must not repopulate the list for a
    // viewer who no longer has a session.
    let releaseList: (value: (typeof KEY)[]) => void = () => {};
    mocks.listApiKeys.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseList = resolve as typeof releaseList;
        }),
    );

    const { result, rerender } = renderHook(
      ({ enabled }) => useApiKeys({ enabled }),
      { initialProps: { enabled: true } },
    );

    rerender({ enabled: false });
    await act(async () => {
      releaseList([KEY]);
      await Promise.resolve();
    });

    expect(result.current.keys).toEqual([]);
  });
});
