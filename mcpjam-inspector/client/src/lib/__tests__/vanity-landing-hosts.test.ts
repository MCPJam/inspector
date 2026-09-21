import { describe, expect, it } from "vitest";
import {
  CANIUSE_LANDING_HOSTS,
  isCaniuseLandingHost,
  isVanityLandingHost,
  shouldSkipGuestSession,
  VANITY_LANDING_HOSTS,
} from "../vanity-landing-hosts";

describe("isVanityLandingHost", () => {
  it("matches every vanity landing, case-insensitively", () => {
    expect(isVanityLandingHost("caniuse.dev")).toBe(true);
    expect(isVanityLandingHost("WWW.CANIUSE.DEV")).toBe(true);
    expect(isVanityLandingHost("score.mcpjam.com")).toBe(true);
  });

  it("does not match the hosted app or localhost", () => {
    expect(isVanityLandingHost("app.mcpjam.com")).toBe(false);
    expect(isVanityLandingHost("localhost")).toBe(false);
  });
});

describe("isCaniuseLandingHost", () => {
  it("matches only the caniuse landings", () => {
    expect(isCaniuseLandingHost("caniuse.dev")).toBe(true);
    expect(isCaniuseLandingHost("WWW.CANIUSE.DEV")).toBe(true);
    expect(isCaniuseLandingHost("score.mcpjam.com")).toBe(false);
    expect(isCaniuseLandingHost("app.mcpjam.com")).toBe(false);
    expect(isCaniuseLandingHost("localhost")).toBe(false);
  });
});

describe("shouldSkipGuestSession", () => {
  it("skips the guest bootstrap on caniuse.dev", () => {
    expect(shouldSkipGuestSession("caniuse.dev")).toBe(true);
    expect(shouldSkipGuestSession("www.caniuse.dev")).toBe(true);
  });

  // The score runner mints runs against a guest identity, so it must keep
  // creating one. This is the guard against widening the skip to every
  // vanity landing.
  it("keeps the guest bootstrap on score.mcpjam.com and the hosted app", () => {
    expect(shouldSkipGuestSession("score.mcpjam.com")).toBe(false);
    expect(shouldSkipGuestSession("app.mcpjam.com")).toBe(false);
    expect(shouldSkipGuestSession("localhost")).toBe(false);
  });

  it("does not skip when the hostname is unknown", () => {
    expect(shouldSkipGuestSession(undefined)).toBe(false);
    expect(shouldSkipGuestSession("")).toBe(false);
  });
});

describe("host sets", () => {
  // LANDING_ANALYTICS_HOSTS aliases VANITY_LANDING_HOSTS, so narrowing this
  // set would silently drop score.mcpjam.com's web analytics.
  it("keeps every landing in the union", () => {
    expect([...VANITY_LANDING_HOSTS].sort()).toEqual([
      "caniuse.dev",
      "score.mcpjam.com",
      "www.caniuse.dev",
      "www.score.mcpjam.com",
    ]);
    expect([...CANIUSE_LANDING_HOSTS].sort()).toEqual([
      "caniuse.dev",
      "www.caniuse.dev",
    ]);
  });
});
