import { describe, expect, it } from "vitest";
import { canPromoteSessions } from "../useProjects";

// Promoting a session into an eval test case is member-gated on the backend
// (`PROMOTION_POLICIES` — chatbox and swarm both require project 'member').
// This is the pure decision the affordance keys off.
//
// The gate matters most on User Testing, which — unlike Swarms — is
// deliberately VISIBLE to project guests. A guest may read a tester's
// transcript; copying it into a durable member-owned suite artifact is a
// different act, so the surface stays open and the button does not.
describe("canPromoteSessions", () => {
  it("allows member-or-above roles", () => {
    expect(canPromoteSessions("owner")).toBe(true);
    expect(canPromoteSessions("admin")).toBe(true);
    expect(canPromoteSessions("member")).toBe(true);
  });

  it("denies a project guest who can still READ the session", () => {
    expect(canPromoteSessions("guest")).toBe(false);
  });

  it("denies an unresolved role, so the button never flashes in", () => {
    expect(canPromoteSessions(undefined)).toBe(false);
  });
});
