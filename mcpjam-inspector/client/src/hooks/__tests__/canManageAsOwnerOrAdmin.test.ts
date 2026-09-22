/**
 * The admin gate shared by SwarmsTab and the Project Environments route.
 *
 * This branch has to serve two incompatible identity models at once — WorkOS
 * members (who get a project role) and anonymous Convex owners (who never do)
 * — so it is unit-tested here rather than left inline in a route component
 * where a future edit could silently re-expose admin controls.
 */
import { describe, expect, it } from "vitest";
import { canManageAsOwnerOrAdmin } from "../useProjects";

const base = {
  isWorkOsSignedIn: false,
  role: undefined,
  isAuthenticated: true,
  hasProject: true,
  identityLoading: false,
} as const;

describe("canManageAsOwnerOrAdmin", () => {
  it("grants management to a SETTLED anonymous Convex owner", () => {
    // No WorkOS identity ⇒ no role, ever. They still own the project.
    expect(canManageAsOwnerOrAdmin({ ...base })).toBe(true);
  });

  it("denies while WorkOS is still hydrating (fail-closed)", () => {
    // Indistinguishable from a member whose role hasn't loaded yet.
    expect(canManageAsOwnerOrAdmin({ ...base, identityLoading: true })).toBe(
      false
    );
  });

  it("denies an unauthenticated viewer and a viewer with no project", () => {
    expect(canManageAsOwnerOrAdmin({ ...base, isAuthenticated: false })).toBe(
      false
    );
    expect(canManageAsOwnerOrAdmin({ ...base, hasProject: false })).toBe(false);
  });

  it("routes a WorkOS-signed-in viewer through the role gate", () => {
    const workos = { ...base, isWorkOsSignedIn: true };
    expect(canManageAsOwnerOrAdmin({ ...workos, role: "owner" })).toBe(true);
    expect(canManageAsOwnerOrAdmin({ ...workos, role: "admin" })).toBe(true);
    // A member can VIEW these surfaces but must never get write affordances.
    expect(canManageAsOwnerOrAdmin({ ...workos, role: "member" })).toBe(false);
    expect(canManageAsOwnerOrAdmin({ ...workos, role: "guest" })).toBe(false);
  });

  it("denies a WorkOS viewer whose role has not resolved", () => {
    // The anonymous-owner escape hatch must NOT leak to WorkOS users mid-load.
    expect(
      canManageAsOwnerOrAdmin({
        ...base,
        isWorkOsSignedIn: true,
        role: undefined,
      })
    ).toBe(false);
  });
});
