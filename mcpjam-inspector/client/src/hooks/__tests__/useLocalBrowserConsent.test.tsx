import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));
vi.mock("@/lib/session-token", () => ({ authFetch: request }));

import { useLocalBrowserConsent } from "../useLocalBrowserConsent";

const STORAGE_KEY = "mcp-local-browser-consent-v1";
const grant = {
  token: "shared-browser-consent-token",
  grantedAt: "2026-09-10T12:00:00.000Z",
};

describe("shared Browser permission", () => {
  beforeEach(() => {
    localStorage.clear();
    request.mockReset().mockImplementation(async () => Response.json(grant));
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
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "/api/mcp/computers/local-browser/consent/grant",
      expect.objectContaining({ method: "POST" }),
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
      expect(request).toHaveBeenLastCalledWith(
        "/api/mcp/computers/local-browser/consent/revoke",
        expect.objectContaining({
          body: JSON.stringify({ token: grant.token }),
        }),
      );
    } finally {
      save.mockRestore();
    }
  });
});
