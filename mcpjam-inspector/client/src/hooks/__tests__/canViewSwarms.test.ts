import { describe, expect, it } from "vitest";
import { canViewSwarms, isViewerRolePending } from "../useProjects";

// The Swarms surface is member-only on the backend; `canViewSwarms` is the
// pure decision the route gate keys off. Owners/admins/members may view;
// guests — and any unresolved (loading / not-a-member) role — may not.
describe("canViewSwarms", () => {
  it("allows member-or-above roles", () => {
    expect(canViewSwarms("owner")).toBe(true);
    expect(canViewSwarms("admin")).toBe(true);
    expect(canViewSwarms("member")).toBe(true);
  });

  it("denies a project guest", () => {
    expect(canViewSwarms("guest")).toBe(false);
  });

  it("denies an unresolved role (loading / not a member)", () => {
    expect(canViewSwarms(undefined)).toBe(false);
  });
});

// Regression: WorkOS `user.email` hydrates AFTER Convex auth flips true. The
// members list can resolve first, so the gate must keep "loading" (not deny)
// until identity settles — otherwise a real member flashes access-denied.
//
// Equally important: Convex guest sessions are also `isAuthenticated` but never
// get a WorkOS email. Pending must be bounded by `identityLoading`, not by
// "authenticated && !email", or the Swarms gate spins forever.
describe("isViewerRolePending", () => {
  it("is pending while the identity provider is still hydrating", () => {
    expect(isViewerRolePending(false, true, undefined)).toBe(true);
    expect(isViewerRolePending(false, true, "a@b.com")).toBe(true);
  });

  it("is pending while the members list is loading for a known identity", () => {
    expect(isViewerRolePending(true, false, "a@b.com")).toBe(true);
  });

  it("is resolved once the email hydrates and members are loaded", () => {
    expect(isViewerRolePending(false, false, "a@b.com")).toBe(false);
  });

  it("is resolved (deny) when identity settled with no email — Convex guests", () => {
    // Guest sessions flip Convex auth true without ever producing WorkOS email.
    // Do NOT keep pending forever; callers deny via canViewSwarms(undefined).
    expect(isViewerRolePending(false, false, undefined)).toBe(false);
    expect(isViewerRolePending(false, false, null)).toBe(false);
    expect(isViewerRolePending(false, false, "   ")).toBe(false);
    // Members list is irrelevant without an email to match — don't wait on it.
    expect(isViewerRolePending(true, false, undefined)).toBe(false);
  });
});
