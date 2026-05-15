import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { pathnameToActiveTab, useActiveTab } from "../app-navigation";

describe("pathnameToActiveTab", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    window.location.hash = "";
  });

  it("returns known app tabs", () => {
    expect(pathnameToActiveTab("/servers")).toBe("servers");
    expect(pathnameToActiveTab("/tools")).toBe("tools");
    expect(pathnameToActiveTab("/organizations/org-a/billing")).toBe(
      "organizations",
    );
  });

  it("normalizes aliases", () => {
    expect(pathnameToActiveTab("/chat/thread-1")).toBe("chat-v2");
  });

  it("renders special entry paths through the servers fallback", () => {
    expect(pathnameToActiveTab("/billing")).toBe("servers");
    expect(pathnameToActiveTab("/billing/")).toBe("servers");
    expect(pathnameToActiveTab("/callback")).toBe("servers");
    expect(pathnameToActiveTab("/oauth/callback")).toBe("servers");
    expect(pathnameToActiveTab("/oauth/callback/debug")).toBe("servers");
  });

  it("uses servers for unknown paths", () => {
    expect(pathnameToActiveTab("/not-a-tab")).toBe("servers");
    expect(pathnameToActiveTab("/chatbox-session-slug")).toBe("servers");
  });

  it("falls back to legacy hash navigation outside a Router", () => {
    window.location.hash = "#oauth-flow";

    const { result } = renderHook(() => useActiveTab());

    expect(result.current).toBe("oauth-flow");
  });

  it("does not treat arbitrary chatbox session hashes as app tabs", () => {
    window.location.hash = "#chatbox-slug";

    const { result } = renderHook(() => useActiveTab());

    expect(result.current).toBe("servers");
  });
});
