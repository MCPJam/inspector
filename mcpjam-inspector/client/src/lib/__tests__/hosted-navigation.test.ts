import { describe, expect, it } from "vitest";
import {
  getNormalizedHashParts,
  resolveHostedNavigation,
} from "../hosted-navigation";

describe("hosted-navigation", () => {
  it("normalizes hash aliases and strips hash prefix", () => {
    expect(getNormalizedHashParts("#registry")).toEqual(["servers"]);
    expect(getNormalizedHashParts("#/chat")).toEqual(["chat-v2"]);
    expect(getNormalizedHashParts("prompts")).toEqual(["prompts"]);
  });

  it("marks blocked tabs in hosted mode", () => {
    const resolved = resolveHostedNavigation("#skills", true);
    expect(resolved.normalizedTab).toBe("skills");
    expect(resolved.isBlocked).toBe(true);
  });

  it("allows blocked-hosted tabs in local mode", () => {
    const resolved = resolveHostedNavigation("#skills", false);
    expect(resolved.isBlocked).toBe(false);
  });

  it("extracts organization route params and chat-v2 flags", () => {
    const orgResolved = resolveHostedNavigation("#organizations/org_123", true);
    expect(orgResolved.organizationId).toBe("org_123");
    expect(orgResolved.shouldSelectAllServers).toBe(false);
    expect(orgResolved.shouldClearChatMessages).toBe(true);

    const chatResolved = resolveHostedNavigation("#chat-v2", true);
    expect(chatResolved.organizationId).toBeUndefined();
    expect(chatResolved.shouldSelectAllServers).toBe(true);
    expect(chatResolved.shouldClearChatMessages).toBe(false);
  });

  it("returns canonical section for hash synchronization", () => {
    const resolved = resolveHostedNavigation("#/registry", true);
    expect(resolved.rawSection).toBe("registry");
    expect(resolved.normalizedSection).toBe("servers");
  });
});
