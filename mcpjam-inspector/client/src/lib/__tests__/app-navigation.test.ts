import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  captureCurrentReturnPath,
  isDebugOAuthCallbackPath,
  legacyHashBookmarkToPath,
  navigationTargetToPath,
  normalizeInitialLegacyHashBookmark,
  normalizeReturnTargetPath,
  pathnameToActiveTab,
  shouldSnapToServersOnActiveProjectChange,
  useActiveTab,
} from "../app-navigation";

describe("isDebugOAuthCallbackPath", () => {
  it("matches the OAuth debugger callback popup route", () => {
    expect(isDebugOAuthCallbackPath("/oauth/callback/debug")).toBe(true);
    expect(isDebugOAuthCallbackPath("/oauth/callback/debug/")).toBe(true);
  });

  it("does not match the WorkOS or connect callbacks", () => {
    // These load in the main window and legitimately need <AuthKitProvider>.
    expect(isDebugOAuthCallbackPath("/callback")).toBe(false);
    expect(isDebugOAuthCallbackPath("/oauth/callback")).toBe(false);
  });

  it("does not match unrelated or look-alike paths", () => {
    expect(isDebugOAuthCallbackPath("/oauth/callback/debugger")).toBe(false);
    expect(isDebugOAuthCallbackPath("/servers")).toBe(false);
    expect(isDebugOAuthCallbackPath("/")).toBe(false);
  });
});

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

  it("resolves server-scoped tool destinations (not the servers fallback)", () => {
    // Regression: a route registered in the router + routePaths but missing
    // from KNOWN_APP_TAB_SEGMENTS resolves to "servers", so the shell's
    // flag-redirect / auto-select / active-server-selector never fire.
    expect(pathnameToActiveTab("/conformance")).toBe("conformance");
    expect(pathnameToActiveTab("/compatibility")).toBe("compatibility");
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

describe("shouldSnapToServersOnActiveProjectChange", () => {
  it("snaps to servers when the active project changes on a project-scoped tab", () => {
    expect(
      shouldSnapToServersOnActiveProjectChange({
        previousActiveProjectId: "p1",
        nextActiveProjectId: "p2",
        activeTab: "playground",
      }),
    ).toBe(true);
  });

  it("does NOT snap while on an organizations route", () => {
    // Regression: opening another org's settings via the switcher gear flips
    // the active org, which auto-resolves a new active project as a side
    // effect. Snapping to Servers here bounced the user off the org settings
    // page they just opened.
    expect(
      shouldSnapToServersOnActiveProjectChange({
        previousActiveProjectId: "p1",
        nextActiveProjectId: "p2",
        activeTab: "organizations",
      }),
    ).toBe(false);
  });

  it("does not snap on initial hydration (no previous project id)", () => {
    expect(
      shouldSnapToServersOnActiveProjectChange({
        previousActiveProjectId: null,
        nextActiveProjectId: "p1",
        activeTab: "playground",
      }),
    ).toBe(false);
  });

  it("does not snap when the project id is unchanged", () => {
    expect(
      shouldSnapToServersOnActiveProjectChange({
        previousActiveProjectId: "p1",
        nextActiveProjectId: "p1",
        activeTab: "playground",
      }),
    ).toBe(false);
  });

  it("does not snap across the local-default 'none' placeholder in either direction", () => {
    expect(
      shouldSnapToServersOnActiveProjectChange({
        previousActiveProjectId: "none",
        nextActiveProjectId: "p1",
        activeTab: "playground",
      }),
    ).toBe(false);
    expect(
      shouldSnapToServersOnActiveProjectChange({
        previousActiveProjectId: "p1",
        nextActiveProjectId: "none",
        activeTab: "playground",
      }),
    ).toBe(false);
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
