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
        isLoadingRemoteWorkspaces: false,
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
        isLoadingRemoteWorkspaces: false,
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
        isLoadingRemoteWorkspaces: false,
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
        isLoadingRemoteWorkspaces: false,
      }),
    ).toBe("ready");
  });

  it("returns workspace-loading when auth is ready but workspace data is pending", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        nonProdLockdown: false,
        isConvexAuthLoading: false,
        isConvexAuthenticated: true,
        isWorkOsLoading: false,
        hasWorkOsUser: true,
        workOsUserEmail: "employee@mcpjam.com",
        isLoadingRemoteWorkspaces: true,
      }),
    ).toBe("workspace-loading");
  });

  it("returns ready when hosted auth and workspace are fully ready", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        nonProdLockdown: false,
        isConvexAuthLoading: false,
        isConvexAuthenticated: true,
        isWorkOsLoading: false,
        hasWorkOsUser: true,
        workOsUserEmail: "employee@mcpjam.com",
        isLoadingRemoteWorkspaces: false,
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
        isLoadingRemoteWorkspaces: false,
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
        isLoadingRemoteWorkspaces: false,
      }),
    ).toBe("restricted");
  });
});
