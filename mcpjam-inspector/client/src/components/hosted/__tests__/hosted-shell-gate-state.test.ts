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
        isLoadingRemoteWorkspaces: false,
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
        isLoadingRemoteWorkspaces: false,
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
        isLoadingRemoteWorkspaces: false,
      }),
    ).toBe("auth-loading");
  });

  it("returns logged-out only when neither auth source is authenticated", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        isConvexAuthLoading: false,
        isConvexAuthenticated: false,
        isWorkOsLoading: false,
        hasWorkOsUser: false,
        isLoadingRemoteWorkspaces: false,
      }),
    ).toBe("logged-out");
  });

  it("returns workspace-loading when auth is ready but workspace data is pending", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        isConvexAuthLoading: false,
        isConvexAuthenticated: true,
        isWorkOsLoading: false,
        hasWorkOsUser: true,
        isLoadingRemoteWorkspaces: true,
      }),
    ).toBe("workspace-loading");
  });

  it("returns ready when hosted auth and workspace are fully ready", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        isConvexAuthLoading: false,
        isConvexAuthenticated: true,
        isWorkOsLoading: false,
        hasWorkOsUser: true,
        isLoadingRemoteWorkspaces: false,
      }),
    ).toBe("ready");
  });
});
