import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockConvexAuth, mockWorkOsAuth, mockRole } = vi.hoisted(() => ({
  mockConvexAuth: { isAuthenticated: true, isLoading: false },
  mockWorkOsAuth: {
    user: undefined as { email?: string } | undefined,
    isLoading: false,
  },
  mockRole: {
    role: undefined as string | undefined,
    isLoading: false,
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockConvexAuth,
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockWorkOsAuth,
}));
vi.mock("@/hooks/useProjects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../useProjects")>()),
  useViewerProjectRole: () => mockRole,
}));

import { usePromoteCapability } from "../usePromoteCapability";

const render = (projectId: string | null = "proj-1") =>
  renderHook(() => usePromoteCapability({ projectId })).result.current;

beforeEach(() => {
  mockConvexAuth.isAuthenticated = true;
  mockConvexAuth.isLoading = false;
  mockWorkOsAuth.user = { email: "member@test.local" };
  mockWorkOsAuth.isLoading = false;
  mockRole.role = "member";
  mockRole.isLoading = false;
});

describe("usePromoteCapability", () => {
  it("allows a project member", () => {
    expect(render()).toEqual({ canPromote: true, isLoading: false });
  });

  it("denies a project guest", () => {
    mockRole.role = "guest";
    expect(render()).toEqual({ canPromote: false, isLoading: false });
  });

  // Regression: Convex reports isAuthenticated=false while it is still
  // confirming the initial token. Treating that as a settled "no" renders an
  // empty state, then pops the button in after auth lands.
  it("stays loading while Convex auth is still resolving", () => {
    mockConvexAuth.isLoading = true;
    mockConvexAuth.isAuthenticated = false;
    expect(render()).toEqual({ canPromote: false, isLoading: true });
  });

  it("stays loading while WorkOS identity or the role is resolving", () => {
    mockWorkOsAuth.isLoading = true;
    expect(render()).toEqual({ canPromote: false, isLoading: true });

    mockWorkOsAuth.isLoading = false;
    mockRole.isLoading = true;
    expect(render()).toEqual({ canPromote: false, isLoading: true });
  });

  it("denies an unresolved role once everything has settled (fail closed)", () => {
    mockRole.role = undefined;
    expect(render()).toEqual({ canPromote: false, isLoading: false });
  });

  it("allows an anonymous Convex session (owner of its personal-org project)", () => {
    mockWorkOsAuth.user = undefined;
    mockRole.role = undefined;
    expect(render()).toEqual({ canPromote: true, isLoading: false });
  });

  it("short-circuits without a project, subscribing to nothing", () => {
    expect(render(null)).toEqual({ canPromote: false, isLoading: false });
  });

  it("denies a settled unauthenticated viewer without hanging on loading", () => {
    mockConvexAuth.isAuthenticated = false;
    expect(render()).toEqual({ canPromote: false, isLoading: false });
  });
});
