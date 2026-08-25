import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildConformanceRunPath,
  buildConformanceSharePath,
  buildEvalSharePath,
  buildOrganizationPath,
  buildSessionsPath,
  buildSwarmPath,
  buildUserTestingScenarioEditPath,
  buildUserTestingScenarioPath,
  captureCurrentReturnPath,
  isDebugOAuthCallbackPath,
  isLegacyUserTestingEditTab,
  legacyCiEvalsPathToRunsPath,
  legacyHashBookmarkToPath,
  navigateApp,
  navigationTargetToPath,
  normalizeInitialLegacyHashBookmark,
  normalizeReturnTargetPath,
  parseSwarmDetailTab,
  parseUserTestingDetailTab,
  pathnameToActiveTab,
  buildProjectSettingsTarget,
  buildProjectSwitchTarget,
  scopeNavigationTarget,
  useActiveTab,
  useCurrentOrgRoute,
  useCurrentSearchParam,
} from "../app-navigation";

describe("conformance run and share paths", () => {
  it("builds encoded detail and share URLs", () => {
    // The project is a PATH segment, not `?project=`: a run link has to
    // reopen the same project on a refresh, and a query the app consumed and
    // stripped could not do that.
    expect(buildConformanceRunPath("run/1", "k57aaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
      "/p/k57aaaaaaaaaaaaaaaaaaaaaaaaa/conformance/runs/run%2F1"
    );
    expect(buildConformanceRunPath("run/1")).toBe(
      "/conformance/runs/run%2F1"
    );
    expect(buildConformanceSharePath("tok/en")).toBe(
      "/conformance/shared/tok%2Fen"
    );
    expect(buildEvalSharePath("tok/en")).toBe("/evals/shared/tok%2Fen");
  });
});

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

describe("buildSwarmPath / parseSwarmDetailTab", () => {
  it("builds a swarm detail path and encodes the id", () => {
    expect(buildSwarmPath("wave-1")).toBe("/swarms/wave-1");
    expect(buildSwarmPath("a/b")).toBe("/swarms/a%2Fb");
  });

  it("omits insights (default) from the query and includes sessions", () => {
    expect(buildSwarmPath("wave-1", { tab: "insights" })).toBe(
      "/swarms/wave-1"
    );
    expect(buildSwarmPath("wave-1", { tab: "sessions" })).toBe(
      "/swarms/wave-1?tab=sessions"
    );
    expect(
      buildSwarmPath("wave-1", {
        tab: "sessions",
        session: "thread/1",
        sel: "outcome:goal%3Areached,sentiment:calm",
      })
    ).toBe(
      "/swarms/wave-1?tab=sessions&session=thread%2F1&sel=outcome%3Agoal%253Areached%2Csentiment%3Acalm"
    );
  });

  it("parses known tabs, maps legacy aliases to insights, defaults to insights", () => {
    expect(parseSwarmDetailTab("?tab=insights")).toBe("insights");
    expect(parseSwarmDetailTab("?tab=sessions")).toBe("sessions");
    expect(parseSwarmDetailTab("?tab=personas")).toBe("insights");
    expect(parseSwarmDetailTab("")).toBe("insights");
    expect(parseSwarmDetailTab("?tab=overview")).toBe("insights");
    expect(parseSwarmDetailTab("?tab=nope")).toBe("insights");
    expect(parseSwarmDetailTab("?session=thread-1")).toBe("sessions");
  });

  it("parses the findings tab", () => {
    expect(parseSwarmDetailTab("?tab=findings")).toBe("findings");
    expect(buildSwarmPath("wave-1", { tab: "findings" })).toBe(
      "/swarms/wave-1?tab=findings"
    );
  });
});

describe("User Testing detail / edit navigation", () => {
  it("defaults to Insights and opens Sessions for a session deep-link", () => {
    expect(parseUserTestingDetailTab("")).toBe("insights");
    expect(parseUserTestingDetailTab("?tab=insights")).toBe("insights");
    expect(parseUserTestingDetailTab("?tab=sessions")).toBe("sessions");
    expect(parseUserTestingDetailTab("?session=thread-1")).toBe("sessions");
    expect(parseUserTestingDetailTab("?tab=clusters")).toBe("insights");
  });

  it("builds the edit path and recognizes legacy edit/share/preview tabs", () => {
    expect(buildUserTestingScenarioEditPath("cb-1")).toBe(
      "/user-testing/cb-1/edit"
    );
    expect(buildUserTestingScenarioPath("cb-1")).toBe("/user-testing/cb-1");
    expect(isLegacyUserTestingEditTab("?tab=edit")).toBe(true);
    expect(isLegacyUserTestingEditTab("?tab=share")).toBe(true);
    expect(isLegacyUserTestingEditTab("?tab=preview")).toBe(true);
    expect(isLegacyUserTestingEditTab("?tab=insights")).toBe(false);
  });
});

describe("buildSessionsPath", () => {
  it("builds a bare /sessions path when nothing is focused", () => {
    expect(buildSessionsPath()).toBe("/sessions");
    expect(buildSessionsPath({})).toBe("/sessions");
  });

  it("encodes the focused session and the project scope", () => {
    // This is the shape the backend mints as the universal permalink
    // fallback, so its exact spelling is a wire contract with `/v1/sessions`.
    expect(
      buildSessionsPath({
        session: "k57abc",
        project: "k57bbbbbbbbbbbbbbbbbbbbbbbbb",
      })
    ).toBe("/p/k57bbbbbbbbbbbbbbbbbbbbbbbbb/sessions?session=k57abc");
    expect(buildSessionsPath({ session: "a/b" })).toBe(
      "/sessions?session=a%2Fb"
    );
  });

  it("keeps each param independent", () => {
    expect(buildSessionsPath({ project: "k57bbbbbbbbbbbbbbbbbbbbbbbbb" })).toBe(
      "/p/k57bbbbbbbbbbbbbbbbbbbbbbbbb/sessions"
    );
    expect(buildSessionsPath({ session: "s_1" })).toBe("/sessions?session=s_1");
  });

  it("refuses to scope to an unusable project id", () => {
    // `none` is the local placeholder. A link with it in the canonical
    // position would look authoritative and resolve to nothing.
    expect(buildSessionsPath({ session: "s_1", project: "none" })).toBe(
      "/sessions?session=s_1"
    );
  });

  it("a project switch leaves /sessions, so a stale ?session= cannot render", () => {
    // SessionsPanel keeps its selection in the URL, which in principle could
    // outlive a project switch. This is why it does not: the switch IS a
    // navigation to another project's Servers, which unmounts the panel and
    // replaces the URL outright.
    expect(pathnameToActiveTab("/p/k57ccccccccccccccccccccccccc/sessions")).toBe(
      "sessions"
    );
    expect(buildProjectSwitchTarget("k57ddddddddddddddddddddddddd")).toBe(
      "/p/k57ddddddddddddddddddddddddd/servers"
    );
  });

  it("reads the focused session back off the URL", () => {
    window.history.replaceState({}, "", buildSessionsPath({ session: "s_9" }));
    const { result } = renderHook(() => useCurrentSearchParam("session"));
    expect(result.current).toBe("s_9");
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
    expect(pathnameToActiveTab("/swarms/wave-1")).toBe("swarms");
    expect(pathnameToActiveTab("/organizations/org-a/billing")).toBe(
      "organizations"
    );
  });

  it("resolves server-scoped tool destinations (not the servers fallback)", () => {
    // Regression: a route registered in the router + routePaths but missing
    // from KNOWN_APP_TAB_SEGMENTS resolves to "servers", so the shell's
    // flag-redirect / auto-select / active-server-selector never fire.
    expect(pathnameToActiveTab("/conformance")).toBe("conformance");
    expect(pathnameToActiveTab("/conformance/runs/abc")).toBe("conformance");
    expect(pathnameToActiveTab("/compatibility")).toBe("compatibility");
  });

  it("normalizes aliases", () => {
    expect(pathnameToActiveTab("/chat/thread-1")).toBe("playground");
    expect(pathnameToActiveTab("/hosts")).toBe("clients");
    expect(pathnameToActiveTab("/hosts/host-slack")).toBe("clients");
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
    expect(pathnameToActiveTab("/scenario-session-slug")).toBe("servers");
  });

  it("ignores legacy hashes outside a Router", () => {
    window.location.hash = "#oauth-flow";

    const { result } = renderHook(() => useActiveTab());

    expect(result.current).toBe("home");
  });

  it("does not treat arbitrary scenario session hashes as app tabs", () => {
    window.location.hash = "#scenario-slug";

    const { result } = renderHook(() => useActiveTab());

    expect(result.current).toBe("home");
  });
});

describe("project switch targets", () => {
  const PROJECT_B = "k57bbbbbbbbbbbbbbbbbbbbbbbbb";

  it("sends the picker to the next project's Servers", () => {
    // Deterministic on purpose. The picker navigates and the route
    // coordinator performs the switch; the previous design switched hidden
    // state and repaired the URL from an effect, which raced a second effect
    // doing the same thing from the other direction.
    expect(buildProjectSwitchTarget(PROJECT_B)).toBe(`/p/${PROJECT_B}/servers`);
  });

  it("opens another project's settings without switching first", () => {
    // The per-row gear used to switch the active project AND navigate. One
    // URL does both now, so there is no window in which the app is on project
    // B while the address bar still says A.
    expect(buildProjectSettingsTarget(PROJECT_B)).toBe(
      `/p/${PROJECT_B}/project-settings`
    );
  });

  it("does not mint a scoped path for a placeholder project id", () => {
    expect(buildProjectSwitchTarget("none")).toBe("/servers");
  });
});

describe("scopeNavigationTarget", () => {
  const PROJECT_A = "k57aaaaaaaaaaaaaaaaaaaaaaaaa";
  const from = `/p/${PROJECT_A}/servers`;

  it("carries the current project into a project-owned target", () => {
    expect(scopeNavigationTarget("/playground", from)).toBe(
      `/p/${PROJECT_A}/playground`
    );
    expect(scopeNavigationTarget("/evals/suite/s1?view=runs#case", from)).toBe(
      `/p/${PROJECT_A}/evals/suite/s1?view=runs#case`
    );
  });

  it("never prefixes a global or public target", () => {
    // Settings, Organizations and the WorkOS callback are not project-owned.
    // A project prefix there would be a URL nothing renders.
    expect(scopeNavigationTarget("/settings", from)).toBe("/settings");
    expect(scopeNavigationTarget("/organizations/org_1/billing", from)).toBe(
      "/organizations/org_1/billing"
    );
    expect(scopeNavigationTarget("/callback", from)).toBe("/callback");
    expect(scopeNavigationTarget("/evals/shared/tok", from)).toBe(
      "/evals/shared/tok"
    );
  });

  it("is a no-op from an unscoped location", () => {
    expect(scopeNavigationTarget("/servers", "/servers")).toBe("/servers");
  });

  it("leaves an already-scoped target alone", () => {
    const other = "/p/k57bbbbbbbbbbbbbbbbbbbbbbbbb/servers";
    expect(scopeNavigationTarget(other, from)).toBe(other);
  });

  it("leaves bare query and hash navigations alone", () => {
    // `#scenario-slug` is scenario state, not app navigation.
    expect(scopeNavigationTarget("#scenario-1", from)).toBe("#scenario-1");
    expect(scopeNavigationTarget("?tab=sessions", from)).toBe("?tab=sessions");
  });

  it("refuses to scope an off-origin target", () => {
    expect(scopeNavigationTarget("https://evil.example/servers", from)).toBe(
      "https://evil.example/servers"
    );
    expect(scopeNavigationTarget("//evil.example/servers", from)).toBe(
      "//evil.example/servers"
    );
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
      "/evals/suite/s_1?view=test-cases"
    );
    expect(navigationTargetToPath("chat")).toBe("/playground");
    expect(navigationTargetToPath("not-a-tab")).toBe("/servers");
  });

  it("recognizes old hash bookmarks without claiming scenario slugs", () => {
    expect(legacyHashBookmarkToPath("#servers")).toBe("/servers");
    expect(legacyHashBookmarkToPath("#/evals/suite/s_1")).toBe(
      "/evals/suite/s_1"
    );
    expect(legacyHashBookmarkToPath("#organizations/org-a/billing")).toBe(
      "/organizations/org-a/billing"
    );
    expect(legacyHashBookmarkToPath("#scenario-slug")).toBeNull();
  });

  it("normalizes the initial legacy hash bookmark before router mount", () => {
    window.history.replaceState({}, "", "/#organizations/org-a/billing");

    normalizeInitialLegacyHashBookmark();

    expect(window.location.pathname).toBe("/organizations/org-a/billing");
    expect(window.location.hash).toBe("");
  });

  it("captures and normalizes path-form return targets", () => {
    window.history.replaceState({}, "", "/evals/suite/s_1?fromCommit=abc");

    expect(captureCurrentReturnPath()).toBe("/evals/suite/s_1?fromCommit=abc");
    expect(normalizeReturnTargetPath("#/evals")).toBe("/evals");
    expect(normalizeReturnTargetPath("/tools")).toBe("/tools");
    expect(normalizeReturnTargetPath("#unknown")).toBe("/servers");
    expect(normalizeReturnTargetPath("#unknown", "/callback")).toBe(
      "/callback"
    );
  });

  it("does not persist a synthetic return target for root", () => {
    window.history.replaceState({}, "", "/");

    expect(captureCurrentReturnPath()).toBeNull();
  });
});

describe("organization route sections", () => {
  it("builds a path for each section, defaulting to the overview", () => {
    expect(buildOrganizationPath("org_1")).toBe("/organizations/org_1");
    expect(buildOrganizationPath("org_1", "billing")).toBe(
      "/organizations/org_1/billing"
    );
    expect(buildOrganizationPath("org_1", "models")).toBe(
      "/organizations/org_1/models"
    );
    expect(buildOrganizationPath("org_1", "slack")).toBe(
      "/organizations/org_1/slack"
    );
    expect(buildOrganizationPath("org_1", "discord")).toBe(
      "/organizations/org_1/discord"
    );
  });

  it("parses the slack section off the URL", () => {
    window.history.replaceState({}, "", "/organizations/org_1/slack");
    const { result } = renderHook(() => useCurrentOrgRoute());
    expect(result.current).toEqual({ orgId: "org_1", orgSection: "slack" });
  });

  it("parses the discord section off the URL", () => {
    // Its own section rather than a `?tab=` on Slack's: they are two
    // integrations, not two views of one.
    window.history.replaceState({}, "", "/organizations/org_1/discord");
    const { result } = renderHook(() => useCurrentOrgRoute());
    expect(result.current).toEqual({ orgId: "org_1", orgSection: "discord" });
  });

  it("keeps the sub-tab in the query string, not the path", () => {
    // Three views of one settings section — a path segment per view would mean
    // three route entries and three surface patterns for one screen.
    window.history.replaceState(
      {},
      "",
      "/organizations/org_1/slack?tab=activity"
    );
    const { result } = renderHook(() => ({
      route: useCurrentOrgRoute(),
      tab: useCurrentSearchParam("tab"),
    }));
    expect(result.current.route?.orgSection).toBe("slack");
    // The section comes from the path, the view from the query string.
    expect(result.current.tab).toBe("activity");
  });

  it("falls back to the overview for an unknown section segment", () => {
    window.history.replaceState({}, "", "/organizations/org_1/nope");
    const { result } = renderHook(() => useCurrentOrgRoute());
    expect(result.current?.orgSection).toBe("overview");
  });
});

describe("legacy /ci-evals redirects", () => {
  // These URLs shipped in CI logs, bookmarks, and the SDK quickstart's
  // post-sign-in return path. Without an explicit redirect they fall through
  // to the router's catch-all, which renders Servers — silently wrong, not a
  // 404 the user can recognize.
  it("rewrites every legacy shape onto /evals/runs", () => {
    const cases: Array<[string, string]> = [
      ["/ci-evals", "/evals/runs"],
      ["/ci-evals/create", "/evals/runs/create"],
      ["/ci-evals/commit/abc1234567890", "/evals/runs/commit/abc1234567890"],
      ["/ci-evals/suite/s_123", "/evals/runs/suite/s_123"],
      ["/ci-evals/suite/s_123/edit", "/evals/runs/suite/s_123/edit"],
      ["/ci-evals/suite/s_123/runs/r_9", "/evals/runs/suite/s_123/runs/r_9"],
      ["/ci-evals/suite/s_123/test/t_7", "/evals/runs/suite/s_123/test/t_7"],
      [
        "/ci-evals/suite/s_123/test/t_7/edit",
        "/evals/runs/suite/s_123/test/t_7/edit",
      ],
    ];
    for (const [from, to] of cases) {
      expect(legacyCiEvalsPathToRunsPath(from), from).toBe(to);
    }
  });

  it("carries query and hash through", () => {
    expect(
      legacyCiEvalsPathToRunsPath(
        "/ci-evals/commit/abc123",
        "?suite=s_1&iteration=i_4"
      )
    ).toBe("/evals/runs/commit/abc123?suite=s_1&iteration=i_4");
    expect(
      legacyCiEvalsPathToRunsPath(
        "/ci-evals/suite/s_1/runs/r_2",
        "?iteration=i_4&case=c_1&compareTo=r_1&project=p_9"
      )
    ).toBe(
      "/evals/runs/suite/s_1/runs/r_2?iteration=i_4&case=c_1&compareTo=r_1&project=p_9"
    );
    expect(
      legacyCiEvalsPathToRunsPath("/ci-evals", "?project=p_9", "#frag")
    ).toBe("/evals/runs?project=p_9#frag");
  });

  it("preserves encoded path segments verbatim", () => {
    // Rebuilding from decoded router params would split an id containing a
    // reserved character into extra segments and fail to match.
    expect(legacyCiEvalsPathToRunsPath("/ci-evals/suite/suite%20one")).toBe(
      "/evals/runs/suite/suite%20one"
    );
  });

  it("only rewrites the leading segment", () => {
    expect(legacyCiEvalsPathToRunsPath("/ci-evals/suite/ci-evals")).toBe(
      "/evals/runs/suite/ci-evals"
    );
  });
});

describe("navigateApp scope inheritance", () => {
  const PROJECT_A = "k57aaaaaaaaaaaaaaaaaaaaaaaaa";

  beforeEach(() => {
    window.history.replaceState({}, "", `/p/${PROJECT_A}/servers`);
  });

  it("carries the project through an imperative navigation", () => {
    navigateApp("/playground");
    expect(window.location.pathname).toBe(`/p/${PROJECT_A}/playground`);
  });

  it("honors an explicit unscoped navigation", () => {
    // The escape hatch from an unavailable project: inheriting it here would
    // navigate straight back into the state the user is trying to leave.
    navigateApp("/", { unscoped: true });
    expect(window.location.pathname).toBe("/");
  });
});

describe("scoped paths survive return-target normalization", () => {
  const PROJECT_A = "k57aaaaaaaaaaaaaaaaaaaaaaaaa";

  it("keeps a canonical path intact instead of reducing it to /servers", () => {
    // This is what makes a project link survive a sign-in round trip: the
    // stored path is normalized on the way back out, and normalization used
    // to know only about logical first segments.
    expect(
      normalizeReturnTargetPath(`/p/${PROJECT_A}/evals/suite/s1?view=runs#case`)
    ).toBe(`/p/${PROJECT_A}/evals/suite/s1?view=runs#case`);
    expect(navigationTargetToPath(`/p/${PROJECT_A}/servers`)).toBe(
      `/p/${PROJECT_A}/servers`
    );
  });

  it("normalizes the logical half of a scoped path", () => {
    // `scenarios` is the legacy tab id for User Testing; the canonical path
    // segment is `user-testing`, and the project comes back afterwards.
    expect(navigationTargetToPath(`/p/${PROJECT_A}/scenarios`)).toBe(
      `/p/${PROJECT_A}/user-testing`
    );
  });

  it("still refuses an off-origin return target", () => {
    expect(normalizeReturnTargetPath("https://evil.example/servers")).toBe(
      "/servers"
    );
    expect(normalizeReturnTargetPath("//evil.example/p/x/servers")).toBe(
      "/servers"
    );
  });

  it("keeps a scoped path with an unusable project id out of the canonical position", () => {
    expect(normalizeReturnTargetPath("/p/none/servers")).toBe("/servers");
  });
});
