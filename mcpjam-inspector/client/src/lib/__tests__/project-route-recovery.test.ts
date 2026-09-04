import { describe, expect, it } from "vitest";
import {
  createProjectSignInReturnRecoveryIntent,
  resolveProjectSignInReturnRecovery,
} from "../project-route-recovery";

const STALE = "k5700000000000000000000000a";
const CURRENT = "k5700000000000000000000000b";

describe("project sign-in return recovery", () => {
  it("preserves the page, query and hash when switching to the current project", () => {
    const path = `/p/${STALE}/evals/suite/s1?view=runs#case-3`;
    const intent = createProjectSignInReturnRecoveryIntent(path);

    expect(
      resolveProjectSignInReturnRecovery({
        intent,
        routeState: {
          status: "inaccessible",
          requestedProjectId: STALE,
        },
        membershipProjectIds: new Set([CURRENT]),
        fallbackProject: { id: CURRENT, name: "Default Project" },
      }),
    ).toEqual({
      kind: "switch",
      path: `/p/${CURRENT}/evals/suite/s1?view=runs#case-3`,
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
        },
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
        },
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
        },
        membershipProjectIds: new Set([STALE, CURRENT]),
        fallbackProject: { id: CURRENT, name: "Default Project" },
      }),
    ).toEqual({ kind: "clear" });
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
        },
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
        membershipProjectIds: new Set([STALE]),
        fallbackProject: { id: STALE, name: "Original" },
      }),
    ).toEqual({ kind: "clear" });
    expect(
      resolveProjectSignInReturnRecovery({
        intent,
        routeState: { status: "ready", projectId: CURRENT },
        membershipProjectIds: new Set([CURRENT]),
        fallbackProject: { id: CURRENT, name: "Current" },
      }),
    ).toEqual({ kind: "clear" });
  });
});
