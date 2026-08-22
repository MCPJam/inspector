import { describe, expect, it } from "vitest";
import {
  listAppSurfaceNavSegments,
  listHostedBlockedNavSegments,
} from "@/shared/app-surfaces";
import {
  HOSTED_HASH_BLOCKED_TABS,
  isHostedTabBlocked,
  normalizeHostedHashTab,
} from "../hosted-tab-policy";

describe("hosted-tab-policy", () => {
  it("normalizes legacy hash aliases to canonical tabs", () => {
    expect(normalizeHostedHashTab("chat")).toBe("playground");
    // "registry" is now a first-class tab, not an alias
    expect(normalizeHostedHashTab("registry")).toBe("registry");
  });

  it("every alias points at a nav segment that still exists", () => {
    // An alias whose target was renamed resolves to nothing and the hash
    // falls through to Servers — the same silent failure the allow-list used
    // to cause.
    const segments = new Set(listAppSurfaceNavSegments());
    for (const alias of ["chat", "connect", "hosts", "user-testing", "ci-evals"]) {
      expect(segments.has(normalizeHostedHashTab(alias)), alias).toBe(true);
    }
  });

  it("blocks tracing in hosted mode", () => {
    // The only genuine hosted exclusion: Tracing needs the local OTLP
    // collector, which a hosted deployment has no way to reach.
    expect(HOSTED_HASH_BLOCKED_TABS).toContain("tracing");
    expect(isHostedTabBlocked("tracing")).toBe(true);
  });

  it("derives the blocked list from the surface manifests", () => {
    expect([...HOSTED_HASH_BLOCKED_TABS].sort()).toEqual(
      listHostedBlockedNavSegments().sort()
    );
  });

  it("allows every other surface, including ones added later", () => {
    // The point of the blocklist: a new screen is reachable on hosted the day
    // it lands, with its feature flag — not this file — deciding visibility.
    // `sessions` is here because it spent a release invisible on hosted for
    // exactly the opposite reason (#4210).
    for (const tab of [
      "sessions",
      "scenarios",
      "swarms",
      "evals",
      "environments",
      "conformance",
      "compatibility",
      "oauth-flow",
      "xaa-flow",
      "learning",
      "registry",
      "tasks",
      "computer",
      "skills",
      "playground",
    ]) {
      expect(isHostedTabBlocked(tab), tab).toBe(false);
    }
  });

  it("resolves legacy aliases before deciding availability", () => {
    expect(isHostedTabBlocked("chat")).toBe(false);
    expect(isHostedTabBlocked("ci-evals")).toBe(false);
    expect(isHostedTabBlocked("user-testing")).toBe(false);
  });

  it("treats an unknown segment as allowed, not blocked", () => {
    // Existence is `isKnownAppTabSegment`'s question (app-navigation.ts).
    // This module answers availability only, and must not double as a
    // second, staler registry of what exists.
    expect(isHostedTabBlocked("auth")).toBe(false);
    expect(isHostedTabBlocked("some-tab-added-next-quarter")).toBe(false);
  });
});
