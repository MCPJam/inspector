/**
 * The transport check in front of a user's bearer.
 *
 * `setAuth` puts the caller's token on every request this client makes, so the
 * URL it is pointed at decides whether a live credential goes out in
 * cleartext. Exercised through the public query rather than by exporting the
 * private guard, because what matters is that the CLIENT IS NEVER BUILT for a
 * URL that fails the check — a guard that throws after `setAuth` would pass a
 * test of the guard alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const convexState = vi.hoisted(() => ({
  constructed: [] as string[],
  authed: [] as string[],
  queryResult: null as unknown,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    constructor(url: string) {
      convexState.constructed.push(url);
    }
    setAuth(token: string) {
      convexState.authed.push(token);
    }
    async query() {
      return convexState.queryResult;
    }
  },
}));

vi.mock("@/convex/_generated/api", () => ({
  api: { projectComputers: { getComputerStatus: "getComputerStatus" } },
}));

import { convexGetDesktopComputerStatus } from "../convex-environment-client";

beforeEach(() => {
  convexState.constructed.length = 0;
  convexState.authed.length = 0;
  convexState.queryResult = null;
});

afterEach(() => vi.unstubAllEnvs());

const call = () => convexGetDesktopComputerStatus("Bearer tok", "proj-1");

describe("the bearer only travels over a safe transport", () => {
  for (const url of [
    "https://example.convex.cloud",
    // `convex dev` runs a local backend over plain http. Refusing it would
    // break every local developer to defend a hop that never leaves the
    // machine.
    "http://127.0.0.1:3210",
    "http://localhost:3210",
    "http://[::1]:3210",
  ]) {
    it(`accepts ${url}`, async () => {
      vi.stubEnv("CONVEX_URL", url);
      await call();
      expect(convexState.constructed).toEqual([url]);
      expect(convexState.authed).toEqual(["tok"]);
    });
  }

  for (const [label, url] of [
    ["a non-loopback http host", "http://convex.example.com"],
    ["an http host that merely LOOKS loopback", "http://localhost.evil.test"],
    ["a non-http scheme", "ftp://example.com"],
  ] as const) {
    it(`refuses ${label}, and builds no client`, async () => {
      vi.stubEnv("CONVEX_URL", url);
      await expect(call()).rejects.toThrow(/cleartext/);
      // The assertion with teeth: nothing was constructed, so `setAuth` never
      // ran and the bearer never reached a request.
      expect(convexState.constructed).toEqual([]);
      expect(convexState.authed).toEqual([]);
    });
  }

  it("refuses a malformed URL by name", async () => {
    vi.stubEnv("CONVEX_URL", "not a url at all");
    await expect(call()).rejects.toThrow(/not a valid URL/);
    expect(convexState.constructed).toEqual([]);
  });

  for (const [label, value] of [
    ["unset", undefined],
    ["empty", ""],
  ] as const) {
    it(`says so plainly when CONVEX_URL is ${label}`, async () => {
      if (value === undefined) vi.stubEnv("CONVEX_URL", "");
      else vi.stubEnv("CONVEX_URL", value);
      await expect(call()).rejects.toThrow(/CONVEX_URL is not configured/);
      expect(convexState.constructed).toEqual([]);
    });
  }
});
