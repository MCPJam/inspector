import { describe, expect, it } from "vitest";
import {
  createProjectSignInReturnRecoveryIntent,
  resolveProjectSignInReturnRecovery,
} from "../project-route-recovery";

const STALE = "k5700000000000000000000000a";
const CURRENT = "k5700000000000000000000000b";

describe("project sign-in return recovery", () => {
  it("waits until membership data is authoritative", () => {
    const intent = createProjectSignInReturnRecoveryIntent(
      `/p/${STALE}/servers`,
    );

    expect(
      resolveProjectSignInReturnRecovery({
        intent,
        membershipProjectIds: undefined,
        fallbackProjectId: CURRENT,
      }),
    ).toEqual({ kind: "wait" });
  });

  it("opens a valid saved project without changing its URL", () => {
    const path = `/p/${CURRENT}/evals/suite/s1?view=runs#case-3`;

    expect(
      resolveProjectSignInReturnRecovery({
        intent: createProjectSignInReturnRecoveryIntent(path),
        membershipProjectIds: new Set([CURRENT]),
        fallbackProjectId: CURRENT,
      }),
    ).toEqual({ kind: "open", path });
  });

  it("preserves the saved page, query and hash when switching projects", () => {
    const path = `/p/${STALE}/evals/suite/s1?view=runs#case-3`;

    expect(
      resolveProjectSignInReturnRecovery({
        intent: createProjectSignInReturnRecoveryIntent(path),
        membershipProjectIds: new Set([CURRENT]),
        fallbackProjectId: CURRENT,
      }),
    ).toEqual({
      kind: "switch",
      path: `/p/${CURRENT}/evals/suite/s1?view=runs#case-3`,
    });
  });

  it("opens malformed scoped returns so normal route handling reports them", () => {
    const path = "/p/not-a-project/servers";

    expect(
      resolveProjectSignInReturnRecovery({
        intent: createProjectSignInReturnRecoveryIntent(path),
        membershipProjectIds: new Set([CURRENT]),
        fallbackProjectId: CURRENT,
      }),
    ).toEqual({ kind: "open", path });
  });

  it("uses home when the account has no valid fallback project", () => {
    expect(
      resolveProjectSignInReturnRecovery({
        intent: createProjectSignInReturnRecoveryIntent(
          `/p/${STALE}/playground`,
        ),
        membershipProjectIds: new Set(),
        fallbackProjectId: null,
      }),
    ).toEqual({ kind: "home" });

    expect(
      resolveProjectSignInReturnRecovery({
        intent: createProjectSignInReturnRecoveryIntent(
          `/p/${STALE}/playground`,
        ),
        membershipProjectIds: new Set([CURRENT]),
        fallbackProjectId: STALE,
      }),
    ).toEqual({ kind: "home" });
  });

  it("does nothing when the selected sign-in return is unscoped", () => {
    expect(
      resolveProjectSignInReturnRecovery({
        intent: createProjectSignInReturnRecoveryIntent("/servers"),
        membershipProjectIds: new Set([CURRENT]),
        fallbackProjectId: CURRENT,
      }),
    ).toEqual({ kind: "none" });
  });
});

// Auth-transition recovery drops detail IDs instead of moving them between projects.
it.each(["k5700000000000000000000000b", null, "k5700000000000000000000000a"])(
  "recovers to a verified project's Home (preferred %s)",
  (fallbackProjectId) => {
    const intent = createProjectSignInReturnRecoveryIntent(
      `/p/k5700000000000000000000000a/evals/suite/old?view=runs#case`,
    )!;
    intent.fallback = "home";
    expect(
      resolveProjectSignInReturnRecovery({
        intent,
        membershipProjectIds: new Set(["k5700000000000000000000000b"]),
        fallbackProjectId,
      }),
    ).toEqual({ kind: "switch", path: "/p/k5700000000000000000000000b/home" });
  },
);
it("keeps a deliberate sign-in link without transition provenance unchanged", () => {
  const intent = createProjectSignInReturnRecoveryIntent(
    "/p/k5700000000000000000000000a/home",
  )!;
  intent.fallback = "none";
  expect(
    resolveProjectSignInReturnRecovery({
      intent,
      membershipProjectIds: new Set(),
      fallbackProjectId: null,
    }),
  ).toEqual({ kind: "open", path: intent.path });
});
