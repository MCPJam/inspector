import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthFetch = vi.hoisted(() => vi.fn());
const config = vi.hoisted(() => ({ hosted: false }));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return config.hosted;
  },
}));

import {
  getBrowserProfileArchivesAvailable,
  resetBrowserProfileAvailabilityForTests,
} from "../availability";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getBrowserProfileArchivesAvailable", () => {
  beforeEach(() => {
    config.hosted = false;
    mockAuthFetch.mockReset();
    resetBrowserProfileAvailabilityForTests();
  });

  it("never asks a hosted server", async () => {
    config.hosted = true;

    await expect(getBrowserProfileArchivesAvailable()).resolves.toBe(true);
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("remembers a server's clear no", async () => {
    mockAuthFetch.mockResolvedValue(json(200, { archives: false }));

    await expect(getBrowserProfileArchivesAvailable()).resolves.toBe(false);
    await expect(getBrowserProfileArchivesAvailable()).resolves.toBe(false);
    expect(mockAuthFetch).toHaveBeenCalledExactlyOnceWith(
      "/api/web/browser-profiles/availability",
    );
  });

  it("reads yes from a server that can", async () => {
    mockAuthFetch.mockResolvedValue(json(200, { archives: true }));

    await expect(getBrowserProfileArchivesAvailable()).resolves.toBe(true);
  });

  it.each([
    ["an older server without the route", () => json(404, {})],
    ["a signed-out caller", () => json(403, { code: "FORBIDDEN" })],
    [
      "a failed request",
      () => {
        throw new Error("offline");
      },
    ],
  ])("leaves the UI as it was for %s, and asks again", async (_l, answer) => {
    mockAuthFetch.mockImplementationOnce(async () => answer());
    mockAuthFetch.mockResolvedValueOnce(json(200, { archives: false }));

    await expect(getBrowserProfileArchivesAvailable()).resolves.toBe(true);
    await expect(getBrowserProfileArchivesAvailable()).resolves.toBe(false);
    expect(mockAuthFetch).toHaveBeenCalledTimes(2);
  });
});
