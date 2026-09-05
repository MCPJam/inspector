import { describe, expect, it } from "vitest";
import {
  createProjectSignInReturnRecoveryIntent,
  resolveProjectSignInReturnRecovery,
} from "../project-route-recovery";

const STALE = "k5700000000000000000000000a";
const CURRENT = "k5700000000000000000000000b";

describe("project sign-in return recovery", () => {
  it("preserves the current page, query and hash when switching projects", () => {
    const intent = createProjectSignInReturnRecoveryIntent(
      `/p/${STALE}/evals/suite/s1?view=runs#case-3`,
    );
    const currentPath = `/p/${STALE}/servers?tab=tools#details`;

    expect(
      resolveProjectSignInReturnRecovery({
        intent,
        routeState: {
          status: "inaccessible",
          requestedProjectId: STALE,
          reason: "not-a-member",
        },
        currentPath,
        membershipProjectIds: new Set([CURRENT]),
        fallbackProject: { id: CURRENT, name: "Default Project" },
      }),
    ).toEqual({
      kind: "switch",
      path: `/p/${CURRENT}/servers?tab=tools#details`,
      message: "Project not found. Switched to Default Project.",
    });
  });

  it("does nothing for a direct inaccessible URL", () => {
    expect(
      resolveProjectSignInReturnRecovery({
        intent: null,
        routeState: {
          status: "inaccessible",
          requestedProjectId: STALE,
          reason: "not-a-member",
        },
        currentPath: `/p/${STALE}/servers`,
        membershipProjectIds: new Set([CURRENT]),
        fallbackProject: { id: CURRENT, name: "Default Project" },
      }),
    ).toEqual({ kind: "none" });
  });

  it("does not hide malformed URLs or switch timeouts", () => {
    const malformed = createProjectSignInReturnRecoveryIntent(
      "/p/not-a-project/servers",
    );
    expect(
      resolveProjectSignInReturnRecovery({
        intent: malformed,
        routeState: {
          status: "inaccessible",
          requestedProjectId: "not-a-project",
          reason: "malformed",
        },
        currentPath: "/p/not-a-project/servers",
        membershipProjectIds: new Set([CURRENT]),
        fallbackProject: { id: CURRENT, name: "Default Project" },
      }),
    ).toEqual({ kind: "clear" });

    const intent = createProjectSignInReturnRecoveryIntent(
      `/p/${STALE}/servers`,
    );
    expect(
      resolveProjectSignInReturnRecovery({
        intent,
        routeState: {
          status: "inaccessible",
          requestedProjectId: STALE,
          reason: "timed-out",
        },
        currentPath: `/p/${STALE}/servers`,
        membershipProjectIds: new Set([CURRENT]),
        fallbackProject: { id: CURRENT, name: "Default Project" },
      }),
    ).toEqual({ kind: "clear" });
  });

  it("keeps the recovery intent until membership data has loaded", () => {
    const intent = createProjectSignInReturnRecoveryIntent(
      `/p/${STALE}/servers`,
    );
    const input = {
      intent,
      routeState: {
        status: "inaccessible" as const,
        requestedProjectId: STALE,
        reason: "not-a-member" as const,
      },
      currentPath: `/p/${STALE}/servers`,
      fallbackProject: { id: CURRENT, name: "Default Project" },
    };

    expect(
      resolveProjectSignInReturnRecovery({
        ...input,
        membershipProjectIds: undefined,
      }),
    ).toEqual({ kind: "none" });
    expect(
      resolveProjectSignInReturnRecovery({
        ...input,
        membershipProjectIds: new Set([CURRENT]),
      }).kind,
    ).toBe("switch");
  });

  it("uses home when the account has no fallback project", () => {
    const intent = createProjectSignInReturnRecoveryIntent(
      `/p/${STALE}/playground`,
    );
    expect(
      resolveProjectSignInReturnRecovery({
        intent,
        routeState: {
          status: "inaccessible",
          requestedProjectId: STALE,
          reason: "not-a-member",
        },
        currentPath: `/p/${STALE}/playground`,
        membershipProjectIds: new Set(),
        fallbackProject: null,
      }),
    ).toEqual({ kind: "home" });
  });

  it("clears its one-shot intent after success or unrelated navigation", () => {
    const intent = createProjectSignInReturnRecoveryIntent(
      `/p/${STALE}/servers`,
    );
    expect(
      resolveProjectSignInReturnRecovery({
        intent,
        routeState: { status: "ready", projectId: STALE },
        currentPath: `/p/${STALE}/servers`,
        membershipProjectIds: new Set([STALE]),
        fallbackProject: { id: STALE, name: "Original" },
      }),
    ).toEqual({ kind: "clear" });
    expect(
      resolveProjectSignInReturnRecovery({
        intent,
        routeState: { status: "ready", projectId: CURRENT },
        currentPath: `/p/${CURRENT}/servers`,
        membershipProjectIds: new Set([CURRENT]),
        fallbackProject: { id: CURRENT, name: "Current" },
      }),
    ).toEqual({ kind: "clear" });
  });
});
