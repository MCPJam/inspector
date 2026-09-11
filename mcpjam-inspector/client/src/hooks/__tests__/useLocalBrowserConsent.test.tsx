import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const request = vi.hoisted(() => vi.fn());
const mode = vi.hoisted(() => ({ hosted: false }));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return mode.hosted;
  },
}));
vi.mock("@/lib/session-token", () => ({ authFetch: request }));

import { useLocalBrowserConsent } from "../useLocalBrowserConsent";

const STORAGE_KEY = "mcp-local-browser-consent-v1";
const grant = {
  token: "shared-browser-consent-token",
  grantedAt: "2026-09-10T12:00:00.000Z",
};

describe("shared Browser permission", () => {
  it("explains a server rollout denial without saving consent or enabling clients", async () => {
    request.mockResolvedValue(
      Response.json(
        {
          error: "Browser is disabled on this server",
          code: "browser_runtime_unavailable",
        },
        { status: 404 },
      ),
    );
    const hook = renderHook(() => useLocalBrowserConsent());
    await act(async () => {
      await expect(hook.result.current.grant()).rejects.toThrow(
        "Local Browser isn't enabled for this user or server.",
      );
    });
    expect(hook.result.current.granted).toBe(false);
    expect(hook.result.current.token).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  beforeEach(() => {
    localStorage.clear();
    mode.hosted = false;
    request
      .mockReset()
      .mockImplementation(async (url: string) =>
        Response.json(url.endsWith("/verify") ? { valid: true } : grant),
      );
  });

  it("shares one grant with mounted clients and views opened later", async () => {
    const webmcp = renderHook(() => useLocalBrowserConsent());
    const playground = renderHook(() => useLocalBrowserConsent());
    expect(playground.result.current.granted).toBe(false);

    await act(async () => {
      expect(await webmcp.result.current.grant()).toBe(true);
    });

    expect(playground.result.current.token).toBe(grant.token);
    webmcp.unmount();
    const anotherClient = renderHook(() => useLocalBrowserConsent());
    expect(anotherClient.result.current.token).toBe(grant.token);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      "/api/mcp/computers/local-browser/consent/grant",
      expect.objectContaining({ method: "POST" }),
    );
    expect(request).toHaveBeenLastCalledWith(
      "/api/mcp/computers/local-browser/enable-clients",
      expect.objectContaining({
        headers: { "X-MCPJam-Browser-Consent": grant.token },
      }),
    );
  });

  it("receives a grant saved in another tab without minting again", () => {
    const playground = renderHook(() => useLocalBrowserConsent());

    act(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(grant));
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });

    expect(playground.result.current.token).toBe(grant.token);
    expect(request).not.toHaveBeenCalled();
  });

  it("revokes permission in every mounted view", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(grant));
    const webmcp = renderHook(() => useLocalBrowserConsent());
    const playground = renderHook(() => useLocalBrowserConsent());

    await act(async () => {
      await webmcp.result.current.revoke();
    });

    expect(webmcp.result.current.granted).toBe(false);
    expect(playground.result.current.granted).toBe(false);
    expect(request).toHaveBeenCalledWith(
      "/api/mcp/computers/local-browser/consent/revoke",
      expect.objectContaining({ body: JSON.stringify({ token: grant.token }) }),
    );
  });

  it("keeps all views unconsented when saving the grant fails", async () => {
    const webmcp = renderHook(() => useLocalBrowserConsent());
    const playground = renderHook(() => useLocalBrowserConsent());
    const save = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    try {
      await act(async () => {
        expect(await webmcp.result.current.grant()).toBe(false);
      });
      expect(webmcp.result.current.granted).toBe(false);
      expect(playground.result.current.granted).toBe(false);
      expect(request).not.toHaveBeenCalled();
    } finally {
      save.mockRestore();
    }
  });

  it("keeps failed setup pending across reload and retries without rotating consent", async () => {
    request.mockImplementation(async (url: string) =>
      url.endsWith("/enable-clients")
        ? Response.json({}, { status: 503 })
        : Response.json(url.endsWith("/verify") ? { valid: true } : grant),
    );
    const first = renderHook(() => useLocalBrowserConsent());
    await act(async () => {
      await expect(first.result.current.grant()).rejects.toThrow("Retry setup");
    });
    expect(first.result.current.granted).toBe(false);
    expect(first.result.current.token).toBe(grant.token);
    first.unmount();
    request.mockClear();
    const reloaded = renderHook(() => useLocalBrowserConsent());
    expect(reloaded.result.current.granted).toBe(false);
    expect(request).not.toHaveBeenCalled();
    request.mockImplementation(async () => Response.json({ valid: true }));
    await act(async () => {
      expect(await reloaded.result.current.grant()).toBe(true);
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "/api/mcp/computers/local-browser/consent/verify",
      "/api/mcp/computers/local-browser/enable-clients",
    ]);
    expect(reloaded.result.current.granted).toBe(true);
    expect(reloaded.result.current.token).toBe(grant.token);
  });

  it("does not apply shared settings merely by mounting with an existing grant", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(grant));
    const hook = renderHook(() => useLocalBrowserConsent());
    expect(hook.result.current.granted).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("cannot activate local permission in hosted mode", async () => {
    mode.hosted = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(grant));
    const hook = renderHook(() => useLocalBrowserConsent());
    expect(hook.result.current.granted).toBe(false);
    expect(await hook.result.current.grant()).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
