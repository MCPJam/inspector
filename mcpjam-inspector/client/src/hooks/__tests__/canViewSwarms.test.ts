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

// Regression: WorkOS `user.email` hydrates AFTER auth flips true. The members
// list can resolve first, so the gate must keep "loading" (not deny) until the
// viewer's email is available — otherwise a real member flashes access-denied.
describe("isViewerRolePending", () => {
  it("is pending while the members list is loading", () => {
    expect(isViewerRolePending(true, true, "a@b.com")).toBe(true);
  });

  it("is pending when authenticated but the email has not hydrated yet", () => {
    // The exact interval the TL flagged: members resolved, email still empty.
    expect(isViewerRolePending(false, true, undefined)).toBe(true);
    expect(isViewerRolePending(false, true, null)).toBe(true);
    expect(isViewerRolePending(false, true, "   ")).toBe(true);
  });

  it("is resolved once the email hydrates and members are loaded", () => {
    expect(isViewerRolePending(false, true, "a@b.com")).toBe(false);
  });

  it("is not pending for an unauthenticated viewer (no email expected)", () => {
    expect(isViewerRolePending(false, false, undefined)).toBe(false);
  });
});
