import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  fetchServerCapabilities,
  resetServerCapabilitiesForTests,
  useServerSupportsFeature,
} from "../server-capabilities";

const TOKENLESS = {
  hostedMode: false,
  hostedServices: false,
  hostedUrl: "https://app.mcpjam.com",
  hostedOnly: ["public-site-relays", "browser-profiles"],
  degraded: [{ id: "api-keys", via: "relay" }],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetServerCapabilitiesForTests();
  fetchMock = vi.fn(async () => Response.json(TOKENLESS));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("server capabilities", () => {
  it("fetches once per page load", async () => {
    await fetchServerCapabilities();
    await fetchServerCapabilities();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/web/capabilities");
  });

  it("reports a hosted-only feature as unsupported", async () => {
    const { result } = renderHook(() =>
      useServerSupportsFeature("public-site-relays"),
    );
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("reports a fallback feature as supported", async () => {
    const { result } = renderHook(() => useServerSupportsFeature("api-keys"));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("stays unknown (null) when an older server has no such route", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(fetchServerCapabilities()).resolves.toBeNull();
    const { result } = renderHook(() =>
      useServerSupportsFeature("public-site-relays"),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toBeNull();
  });
});
