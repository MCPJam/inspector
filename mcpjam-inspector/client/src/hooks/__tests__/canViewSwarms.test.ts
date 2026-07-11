import { describe, expect, it } from "vitest";
import { canViewSwarms } from "../useProjects";

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
