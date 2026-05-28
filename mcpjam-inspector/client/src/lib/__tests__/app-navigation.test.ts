import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  captureCurrentReturnPath,
  legacyHashBookmarkToPath,
  navigationTargetToPath,
  normalizeInitialLegacyHashBookmark,
  normalizeReturnTargetPath,
  pathnameToActiveTab,
  useActiveTab,
} from "../app-navigation";

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
    expect(pathnameToActiveTab("/chat/thread-1")).toBe("playground");
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

  it("ignores legacy hashes outside a Router", () => {
    window.location.hash = "#oauth-flow";

    const { result } = renderHook(() => useActiveTab());

    expect(result.current).toBe("home");
  });

  it("does not treat arbitrary chatbox session hashes as app tabs", () => {
    window.location.hash = "#chatbox-slug";

    const { result } = renderHook(() => useActiveTab());

    expect(result.current).toBe("home");
  });
});

describe("path navigation compatibility helpers", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    window.location.hash = "";
  });

  it("converts app navigation targets to paths", () => {
    expect(navigationTargetToPath("servers")).toBe("/servers");
    expect(navigationTargetToPath("#/evals/suite/s_1?view=test-cases")).toBe(
      "/evals/suite/s_1?view=test-cases",
    );
    expect(navigationTargetToPath("chat")).toBe("/playground");
    expect(navigationTargetToPath("not-a-tab")).toBe("/servers");
  });

  it("recognizes old hash bookmarks without claiming chatbox slugs", () => {
    expect(legacyHashBookmarkToPath("#servers")).toBe("/servers");
    expect(legacyHashBookmarkToPath("#/evals/suite/s_1")).toBe(
      "/evals/suite/s_1",
    );
    expect(legacyHashBookmarkToPath("#organizations/org-a/billing")).toBe(
      "/organizations/org-a/billing",
    );
    expect(legacyHashBookmarkToPath("#chatbox-slug")).toBeNull();
  });

  it("normalizes the initial legacy hash bookmark before router mount", () => {
    window.history.replaceState({}, "", "/#organizations/org-a/billing");

    normalizeInitialLegacyHashBookmark();

    expect(window.location.pathname).toBe("/organizations/org-a/billing");
    expect(window.location.hash).toBe("");
  });

  it("captures and normalizes path-form return targets", () => {
    window.history.replaceState({}, "", "/evals/suite/s_1?fromCommit=abc");

    expect(captureCurrentReturnPath()).toBe(
      "/evals/suite/s_1?fromCommit=abc",
    );
    expect(normalizeReturnTargetPath("#/evals")).toBe("/evals");
    expect(normalizeReturnTargetPath("/tools")).toBe("/tools");
    expect(normalizeReturnTargetPath("#unknown")).toBe("/servers");
    expect(normalizeReturnTargetPath("#unknown", "/callback")).toBe(
      "/callback",
    );
  });

  it("does not persist a synthetic return target for root", () => {
    window.history.replaceState({}, "", "/");

    expect(captureCurrentReturnPath()).toBeNull();
  });
});
