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
    expect(normalizeHostedHashTab("registry")).toBe("servers");
    expect(normalizeHostedHashTab("chat")).toBe("chat-v2");
    expect(normalizeHostedHashTab("chat-v2")).toBe("chat-v2");
  });

  it("keeps prompts visible in hosted sidebar allow-list", () => {
    expect(HOSTED_SIDEBAR_ALLOWED_TABS).toContain("prompts");
    expect(isHostedSidebarTabAllowed("prompts")).toBe(true);
  });

  it("allows profile and organizations hashes in hosted mode", () => {
    expect(HOSTED_HASH_ALLOWED_TABS).toContain("profile");
    expect(HOSTED_HASH_ALLOWED_TABS).toContain("organizations");
    expect(isHostedHashTabAllowed("profile")).toBe(true);
    expect(isHostedHashTabAllowed("organizations")).toBe(true);
  });

  it("blocks tracing and auth hashes in hosted mode", () => {
    expect(HOSTED_HASH_BLOCKED_TABS).toContain("tracing");
    expect(HOSTED_HASH_BLOCKED_TABS).toContain("auth");
    expect(isHostedHashTabBlocked("tracing")).toBe(true);
    expect(isHostedHashTabBlocked("auth")).toBe(true);
  });

  it("treats #chat as allowed after normalization to #chat-v2", () => {
    expect(isHostedHashTabAllowed("chat")).toBe(true);
    expect(isHostedHashTabBlocked("chat")).toBe(false);
  });

  it("hides blocked tabs from hosted sidebar", () => {
    expect(isHostedSidebarTabAllowed("skills")).toBe(false);
    expect(isHostedSidebarTabAllowed("oauth-flow")).toBe(false);
    expect(isHostedSidebarTabAllowed("tasks")).toBe(false);
    expect(isHostedSidebarTabAllowed("evals")).toBe(false);
  });
});
