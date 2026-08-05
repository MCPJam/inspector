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
    mocks.createApiKey.mockResolvedValue({ ...KEY, value: "sk_live_secret" });

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

    expect(created?.value).toBe("sk_live_secret");
    await waitFor(() => expect(result.current.keys).toEqual([KEY]));
  });

  it("rejects create failures rather than swallowing them into state", async () => {
    // Callers differ on presentation — the settings page toasts, the eval
    // quickstart renders inline — so the hook must not choose for them.
    mocks.createApiKey.mockRejectedValue(new Error("not ready"));
    const { result } = renderHook(() => useApiKeys({ enabled: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      result.current.create({ name: "ci", organizationId: "org-1" }),
    ).rejects.toThrow("not ready");
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
});
