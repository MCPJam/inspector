import { describe, expect, it } from "vitest";
import {
  HOSTED_HASH_ALLOWED_TABS,
  HOSTED_HASH_BLOCKED_TABS,
  HOSTED_SIDEBAR_ALLOWED_TABS,
  isHostedHashTabAllowed,
  isHostedHashTabBlocked,
  isHostedSidebarTabAllowed,
  normalizeHostedHashTab,
} from "../hosted-tab-policy";

describe("hosted-tab-policy", () => {
  it("normalizes legacy hash aliases to canonical tabs", () => {
    expect(normalizeHostedHashTab("chat")).toBe("playground");
    // "registry" is now a first-class tab, not an alias
    expect(normalizeHostedHashTab("registry")).toBe("registry");
  });

  it("keeps prompts visible in hosted sidebar allow-list", () => {
    expect(HOSTED_SIDEBAR_ALLOWED_TABS).toContain("prompts");
    expect(isHostedSidebarTabAllowed("prompts")).toBe(true);
  });

  it("keeps evals visible in hosted sidebar allow-list, including Runs", () => {
    // Runs is a mode under `/evals` now, not its own tab. The legacy
    // `ci-evals` id stays an alias so old hash bookmarks resolve rather than
    // falling through to Servers.
    expect(HOSTED_SIDEBAR_ALLOWED_TABS).toContain("evals");
    expect(isHostedSidebarTabAllowed("evals")).toBe(true);
    expect(HOSTED_SIDEBAR_ALLOWED_TABS).not.toContain("ci-evals");
    expect(normalizeHostedHashTab("ci-evals")).toBe("evals");
    expect(isHostedSidebarTabAllowed("ci-evals")).toBe(true);
  });

  it("keeps scenarios visible in hosted navigation", () => {
    expect(HOSTED_SIDEBAR_ALLOWED_TABS).toContain("scenarios");
    expect(HOSTED_HASH_ALLOWED_TABS).toContain("scenarios");
    expect(isHostedSidebarTabAllowed("scenarios")).toBe(true);
    expect(isHostedHashTabAllowed("scenarios")).toBe(true);
    expect(isHostedHashTabBlocked("scenarios")).toBe(false);
  });

  it("allows profile and organizations hashes in hosted mode", () => {
    expect(HOSTED_HASH_ALLOWED_TABS).toContain("profile");
    expect(HOSTED_HASH_ALLOWED_TABS).toContain("organizations");
    expect(isHostedHashTabAllowed("profile")).toBe(true);
    expect(isHostedHashTabAllowed("organizations")).toBe(true);
  });

  it("allows tasks in hosted mode (reconnect-per-poll routes)", () => {
    expect(HOSTED_SIDEBAR_ALLOWED_TABS).toContain("tasks");
    expect(HOSTED_HASH_ALLOWED_TABS).toContain("tasks");
    expect(isHostedSidebarTabAllowed("tasks")).toBe(true);
    expect(isHostedHashTabBlocked("tasks")).toBe(false);
  });

  it("blocks the tracing hash in hosted mode", () => {
    expect(HOSTED_HASH_BLOCKED_TABS).toContain("tracing");
    expect(isHostedHashTabBlocked("tracing")).toBe(true);
  });

  // The Auth surface is retired. Without this, reintroducing it would make the
  // policy silently permissive rather than failing here.
  it("no longer knows about the retired auth surface", () => {
    expect(HOSTED_HASH_BLOCKED_TABS).not.toContain("auth");
    expect(isHostedHashTabBlocked("auth")).toBe(false);
  });

  it("treats #chat as allowed after normalization to #playground", () => {
    expect(isHostedHashTabAllowed("chat")).toBe(true);
    expect(isHostedHashTabBlocked("chat")).toBe(false);
  });

  it("hides blocked tabs from hosted sidebar", () => {
    expect(isHostedSidebarTabAllowed("skills")).toBe(false);
    expect(isHostedSidebarTabAllowed("tracing")).toBe(false);
    expect(isHostedSidebarTabAllowed("evals")).toBe(true);
    expect(isHostedHashTabBlocked("evals")).toBe(false);
  });

  it("allows oauth-flow in hosted sidebar", () => {
    expect(isHostedSidebarTabAllowed("oauth-flow")).toBe(true);
    expect(isHostedHashTabAllowed("oauth-flow")).toBe(true);
    expect(isHostedHashTabBlocked("oauth-flow")).toBe(false);
  });

  it("allows conformance in hosted sidebar", () => {
    expect(HOSTED_SIDEBAR_ALLOWED_TABS).toContain("conformance");
    expect(HOSTED_HASH_ALLOWED_TABS).toContain("conformance");
    expect(isHostedSidebarTabAllowed("conformance")).toBe(true);
    expect(isHostedHashTabAllowed("conformance")).toBe(true);
    expect(isHostedHashTabBlocked("conformance")).toBe(false);
  });

  it("allows xaa-flow in hosted sidebar", () => {
    expect(HOSTED_SIDEBAR_ALLOWED_TABS).toContain("xaa-flow");
    expect(HOSTED_HASH_ALLOWED_TABS).toContain("xaa-flow");
    expect(isHostedSidebarTabAllowed("xaa-flow")).toBe(true);
    expect(isHostedHashTabAllowed("xaa-flow")).toBe(true);
    expect(isHostedHashTabBlocked("xaa-flow")).toBe(false);
  });

  it("allows environments in hosted navigation (visibility stays flag-gated)", () => {
    expect(HOSTED_SIDEBAR_ALLOWED_TABS).toContain("environments");
    expect(HOSTED_HASH_ALLOWED_TABS).toContain("environments");
    expect(isHostedSidebarTabAllowed("environments")).toBe(true);
    expect(isHostedHashTabAllowed("environments")).toBe(true);
    expect(isHostedHashTabBlocked("environments")).toBe(false);
  });

  it("allows learning in hosted navigation", () => {
    expect(HOSTED_SIDEBAR_ALLOWED_TABS).toContain("learning");
    expect(HOSTED_HASH_ALLOWED_TABS).toContain("learning");
    expect(isHostedSidebarTabAllowed("learning")).toBe(true);
    expect(isHostedHashTabAllowed("learning")).toBe(true);
  });

  it("allows the computer hash in hosted mode without adding a sidebar item", () => {
    // Project Computers are reachable in hosted mode (E2B-backed), gated by
    // project membership + entitlement + the `computers-enabled` flag — so the
    // App hosted-mode effect must NOT bounce /computer back to /servers.
    expect(HOSTED_HASH_ALLOWED_TABS).toContain("computer");
    expect(isHostedHashTabAllowed("computer")).toBe(true);
    expect(isHostedHashTabBlocked("computer")).toBe(false);
    // Computer is reached via the Servers tab switcher, not its own sidebar
    // entry, so it deliberately stays out of the sidebar allow-list.
    expect(HOSTED_SIDEBAR_ALLOWED_TABS).not.toContain("computer");
    expect(isHostedSidebarTabAllowed("computer")).toBe(false);
  });
});
