import { describe, expect, it } from "vitest";
import { resolveHostedShellGateState } from "../hosted-shell-gate-state";

describe("resolveHostedShellGateState", () => {
  it("returns ready in local mode", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: false,
        nonProdLockdown: false,
        isConvexAuthLoading: false,
        isConvexAuthenticated: false,
        isWorkOsLoading: false,
        hasWorkOsUser: false,
        workOsUserEmail: null,
      }),
    ).toBe("ready");
  });

  it("returns auth-loading while WorkOS is still loading", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        nonProdLockdown: false,
        isConvexAuthLoading: false,
        isConvexAuthenticated: false,
        isWorkOsLoading: true,
        hasWorkOsUser: false,
        workOsUserEmail: null,
      }),
    ).toBe("auth-loading");
  });

  it("returns auth-loading when WorkOS user exists but Convex auth has not settled", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        nonProdLockdown: false,
        isConvexAuthLoading: false,
        isConvexAuthenticated: false,
        isWorkOsLoading: false,
        hasWorkOsUser: true,
        workOsUserEmail: "employee@mcpjam.com",
      }),
    ).toBe("auth-loading");
  });

  it("returns ready when unauthenticated (no auth gate)", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        nonProdLockdown: false,
        isConvexAuthLoading: false,
        isConvexAuthenticated: false,
        isWorkOsLoading: false,
        hasWorkOsUser: false,
        workOsUserEmail: null,
      }),
    ).toBe("ready");
  });

  it("returns ready when auth is ready (no longer blocks on project data)", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        nonProdLockdown: false,
        isConvexAuthLoading: false,
        isConvexAuthenticated: true,
        isWorkOsLoading: false,
        hasWorkOsUser: true,
        workOsUserEmail: "employee@mcpjam.com",
      }),
    ).toBe("ready");
  });

  it("returns ready when hosted auth and project are fully ready", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        nonProdLockdown: false,
        isConvexAuthLoading: false,
        isConvexAuthenticated: true,
        isWorkOsLoading: false,
        hasWorkOsUser: true,
        workOsUserEmail: "employee@mcpjam.com",
      }),
    ).toBe("ready");
  });

  it("requires sign-in when lockdown is enabled", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        nonProdLockdown: true,
        isConvexAuthLoading: false,
        isConvexAuthenticated: false,
        isWorkOsLoading: false,
        hasWorkOsUser: false,
        workOsUserEmail: null,
      }),
    ).toBe("logged-out");
  });

  it("blocks authenticated users outside employee domains", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        nonProdLockdown: true,
        isConvexAuthLoading: false,
        isConvexAuthenticated: true,
        isWorkOsLoading: false,
        hasWorkOsUser: true,
        workOsUserEmail: "contractor@example.com",
      }),
    ).toBe("restricted");
  });
});
