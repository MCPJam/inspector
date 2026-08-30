import { describe, expect, it } from "vitest";
import { resolveProjectRouteState } from "../project-route-state";

const A = "k5700000000000000000000000a";
const B = "k5700000000000000000000000b";

const base = {
  requestedProjectId: A,
  isAuthLoading: false,
  isAuthenticated: true,
  isLoadingRemoteProjects: false,
  activeProjectId: null as string | null,
  activeOrgProjectIds: new Set<string>(),
  allProjects: undefined as
    | ReadonlyArray<{ _id: string; organizationId?: string }>
    | undefined,
  activeOrganizationId: "org_a" as string | undefined,
};

describe("resolveProjectRouteState", () => {
  it("reports unscoped for a route with no project segment", () => {
    expect(
      resolveProjectRouteState({ ...base, requestedProjectId: null }).state
    ).toEqual({ status: "unscoped" });
  });

  it("is ready when the URL and the active project already agree", () => {
    // Checked before any loading gate, so a refresh on the project you are
    // already in renders without a spinner.
    expect(
      resolveProjectRouteState({
        ...base,
        activeProjectId: A,
        isLoadingRemoteProjects: true,
      }).state
    ).toEqual({ status: "ready", projectId: A });
  });

  it("answers a malformed id immediately, without waiting for auth", () => {
    // `/p/none/...` can never become accessible; holding a spinner on it
    // would be a hang with no end.
    expect(
      resolveProjectRouteState({
        ...base,
        requestedProjectId: "none",
        isAuthLoading: true,
      }).state
    ).toEqual({ status: "inaccessible", requestedProjectId: "none" });
  });

  it("waits for auth and for the project list", () => {
    expect(
      resolveProjectRouteState({ ...base, isAuthLoading: true }).state.status
    ).toBe("resolving");
    expect(
      resolveProjectRouteState({ ...base, isAuthenticated: false }).state.status
    ).toBe("resolving");
    expect(
      resolveProjectRouteState({ ...base, isLoadingRemoteProjects: true }).state
        .status
    ).toBe("resolving");
  });

  it("switches to a project visible under the active organization", () => {
    const { state, effect } = resolveProjectRouteState({
      ...base,
      activeOrgProjectIds: new Set([A]),
    });
    expect(state).toEqual({ status: "resolving", requestedProjectId: A });
    expect(effect).toEqual({ kind: "switch-project", projectId: A });
  });

  it("switches organization FIRST for a cross-organization link", () => {
    const { state, effect } = resolveProjectRouteState({
      ...base,
      allProjects: [{ _id: A, organizationId: "org_b" }],
    });
    expect(state.status).toBe("resolving");
    expect(effect).toEqual({
      kind: "switch-organization",
      organizationId: "org_b",
    });
  });

  it("waits while the membership list is still loading", () => {
    expect(
      resolveProjectRouteState({ ...base, allProjects: undefined }).effect
    ).toEqual({ kind: "none" });
    expect(
      resolveProjectRouteState({ ...base, allProjects: undefined }).state.status
    ).toBe("resolving");
  });

  it("waits when the organization matches but the filtered set lags a render", () => {
    const { state, effect } = resolveProjectRouteState({
      ...base,
      allProjects: [{ _id: A, organizationId: "org_a" }],
    });
    expect(state.status).toBe("resolving");
    expect(effect).toEqual({ kind: "none" });
  });

  it("reports inaccessible for a project outside the viewer's membership", () => {
    // One state for deleted, never existed, and not yours. Telling them apart
    // would make this page an oracle for which project ids are real.
    expect(
      resolveProjectRouteState({
        ...base,
        allProjects: [{ _id: B, organizationId: "org_a" }],
      }).state
    ).toEqual({ status: "inaccessible", requestedProjectId: A });
  });

  it("handles an organization-less project on both sides of the filter", () => {
    // With an organization filter active it can never enter the filtered set,
    // so waiting would hang; with no filter it lands there next pass.
    expect(
      resolveProjectRouteState({
        ...base,
        allProjects: [{ _id: A }],
      }).state.status
    ).toBe("inaccessible");
    expect(
      resolveProjectRouteState({
        ...base,
        activeOrganizationId: undefined,
        allProjects: [{ _id: A }],
      }).state.status
    ).toBe("resolving");
  });

  it("never falls back to another project", () => {
    // The postcondition this whole design exists for: an unavailable project
    // is an error, not a redirect to whatever else is loaded.
    const { state } = resolveProjectRouteState({
      ...base,
      activeProjectId: B,
      activeOrgProjectIds: new Set([B]),
      allProjects: [{ _id: B, organizationId: "org_a" }],
    });
    expect(state).toEqual({ status: "inaccessible", requestedProjectId: A });
  });

  it("gives up once the resolve budget is spent", () => {
    expect(
      resolveProjectRouteState({
        ...base,
        allProjects: [{ _id: A, organizationId: "org_a" }],
        hasExceededResolveBudget: true,
      }).state
    ).toEqual({ status: "inaccessible", requestedProjectId: A });
  });

  it("still reports ready after the budget is spent if the app caught up", () => {
    // A late-but-successful switch must not be overruled by a timer.
    expect(
      resolveProjectRouteState({
        ...base,
        activeProjectId: A,
        hasExceededResolveBudget: true,
      }).state
    ).toEqual({ status: "ready", projectId: A });
  });
});
