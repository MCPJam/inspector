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

  it("returns ready when hosted auth is settled (no longer blocks on project data)", () => {
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

  /**
   * SUTB-6. The Preview embed mounts the whole app shell, so under lockdown
   * the author's own frame rendered this gate's "Sign in to MCPJam to
   * continue" wall over the scenario they had just created — a wall whose
   * button cannot complete inside a frame (`/oauth/callback` is outside the
   * `main.tsx` self-embed exemption). The frame is the author's, in a
   * dashboard that already cleared the gate; it is never the place to gate.
   */
  it("never walls the author's Preview embed under lockdown", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        nonProdLockdown: true,
        embeddedPreview: true,
        isConvexAuthLoading: false,
        isConvexAuthenticated: false,
        isWorkOsLoading: false,
        hasWorkOsUser: false,
        workOsUserEmail: null,
      }),
    ).toBe("ready");
  });

  it("does not apply the employee-domain restriction inside the Preview embed", () => {
    expect(
      resolveHostedShellGateState({
        hostedMode: true,
        nonProdLockdown: true,
        embeddedPreview: true,
        isConvexAuthLoading: false,
        isConvexAuthenticated: true,
        isWorkOsLoading: false,
        hasWorkOsUser: true,
        workOsUserEmail: "contractor@example.com",
      }),
    ).toBe("ready");
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
