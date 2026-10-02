import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  listApiKeys: vi.fn(),
  listOrganizationApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  revokeOrganizationApiKey: vi.fn(),
}));

vi.mock("@/lib/apis/web/api-keys", () => ({
  listApiKeys: (...args: unknown[]) => mocks.listApiKeys(...args),
  listOrganizationApiKeys: (...args: unknown[]) =>
    mocks.listOrganizationApiKeys(...args),
  createApiKey: (...args: unknown[]) => mocks.createApiKey(...args),
  revokeApiKey: (...args: unknown[]) => mocks.revokeApiKey(...args),
  revokeOrganizationApiKey: (...args: unknown[]) =>
    mocks.revokeOrganizationApiKey(...args),
}));

import { useApiKeys } from "../useApiKeys";

const KEY = { id: "key-1", name: "ci", obfuscated_value: "sk_...abcd" };

beforeEach(() => {
  mocks.listApiKeys.mockReset().mockResolvedValue([KEY]);
  mocks.listOrganizationApiKeys
    .mockReset()
    .mockResolvedValue({ items: [KEY], truncated: false });
  mocks.createApiKey.mockReset();
  mocks.revokeApiKey.mockReset().mockResolvedValue(undefined);
  mocks.revokeOrganizationApiKey
    .mockReset()
    .mockResolvedValue({ alreadyRevoked: false });
});

describe("useApiKeys", () => {
  it("reloads key scope when switching organizations", async () => {
    const { result, rerender } = renderHook(
      ({ organizationId }) => useApiKeys({ enabled: true, organizationId }),
      { initialProps: { organizationId: "org-a" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.listOrganizationApiKeys).toHaveBeenLastCalledWith("org-a");
    rerender({ organizationId: "org-b" });
    await waitFor(() =>
      expect(mocks.listOrganizationApiKeys).toHaveBeenLastCalledWith("org-b"),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    // The personal list is a different endpoint and is never asked here.
    expect(mocks.listApiKeys).not.toHaveBeenCalled();
  });

  it("surfaces a truncated organization inventory, and never for the personal list", async () => {
    mocks.listOrganizationApiKeys.mockResolvedValue({
      items: [KEY],
      truncated: true,
    });
    const org = renderHook(() =>
      useApiKeys({ enabled: true, organizationId: "org-a" }),
    );
    await waitFor(() => expect(org.result.current.truncated).toBe(true));

    const personal = renderHook(() => useApiKeys({ enabled: true }));
    await waitFor(() => expect(personal.result.current.loading).toBe(false));
    expect(personal.result.current.truncated).toBe(false);
  });

  it("revokes through the organization endpoint in the organization inventory", async () => {
    const { result } = renderHook(() =>
      useApiKeys({ enabled: true, organizationId: "org-a" }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    mocks.listOrganizationApiKeys.mockResolvedValue({
      items: [],
      truncated: false,
    });
    await act(async () => {
      await result.current.revoke("key-1");
    });

    expect(mocks.revokeOrganizationApiKey).toHaveBeenCalledWith(
      "org-a",
      "key-1",
    );
    // Not the owner-only endpoint, which 404s a key the caller did not mint.
    expect(mocks.revokeApiKey).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.keys).toEqual([]));
  });

  it("passes the chosen lifetime through when creating a key", async () => {
    mocks.createApiKey.mockResolvedValue({ ...KEY, value: "plaintext" });
    const { result } = renderHook(() => useApiKeys({ enabled: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create({
        name: "ci",
        organizationId: "org-1",
        expiresInDays: 30,
      });
    });

    expect(mocks.createApiKey).toHaveBeenCalledWith({
      name: "ci",
      organizationId: "org-1",
      expiresInDays: 30,
    });
  });

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
    expect(mocks.revokeOrganizationApiKey).not.toHaveBeenCalled();
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
