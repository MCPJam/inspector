import { describe, expect, it } from "vitest";
import { resolveHostedShellGateState } from "../hosted-shell-gate-state";

describe("resolveHostedShellGateState", () => {
  it("returns ready in local mode", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: false,
        isConvexAuthLoading: false,
        isConvexAuthenticated: false,
        isWorkOsLoading: false,
        hasWorkOsUser: false,
      }),
    ).toBe("ready");
  });

  it("returns auth-loading while WorkOS is still loading", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        isConvexAuthLoading: false,
        isConvexAuthenticated: false,
        isWorkOsLoading: true,
        hasWorkOsUser: false,
      }),
    ).toBe("auth-loading");
  });

  it("returns auth-loading when WorkOS user exists but Convex auth has not settled", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        isConvexAuthLoading: false,
        isConvexAuthenticated: false,
        isWorkOsLoading: false,
        hasWorkOsUser: true,
      }),
    ).toBe("auth-loading");
  });

  it("returns ready when unauthenticated (no auth gate)", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        isConvexAuthLoading: false,
        isConvexAuthenticated: false,
        isWorkOsLoading: false,
        hasWorkOsUser: false,
      }),
    ).toBe("ready");
  });

  it("returns ready when hosted auth is settled (no longer blocks on project data)", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        isConvexAuthLoading: false,
        isConvexAuthenticated: true,
        isWorkOsLoading: false,
        hasWorkOsUser: true,
      }),
    ).toBe("ready");
  });
});
