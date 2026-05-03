import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as registryHttp from "@/lib/apis/registry-http";
import { useRegistryServers } from "../useRegistryServers";

const { mockGetExistingGuestBearerToken, mockClearGuestSession } = vi.hoisted(
  () => ({
    mockGetExistingGuestBearerToken: vi.fn(),
    mockClearGuestSession: vi.fn(),
  }),
);

vi.mock("@/lib/apis/registry-http", () => ({
  fetchRegistryCatalog: vi.fn().mockResolvedValue([]),
  starRegistryCard: vi.fn(),
  unstarRegistryCard: vi.fn(),
  mergeGuestRegistryStars: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("@/lib/guest-session", () => ({
  getExistingGuestBearerToken: mockGetExistingGuestBearerToken,
  clearGuestSession: mockClearGuestSession,
}));

vi.mock("@/lib/apis/web/context", () => ({
  resetTokenCache: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
}));

// Skipped while REGISTRY_FEATURE_ENABLED is false in useRegistryServers.ts
// (the hook is forced inert until the registry feature ships).
describe.skip("useRegistryServers (guest merge after sign-in)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges guest stars using lookup_only when an existing guest exists", async () => {
    mockGetExistingGuestBearerToken.mockResolvedValue("guest-bearer-1");
    vi.mocked(registryHttp.mergeGuestRegistryStars).mockResolvedValue(undefined);

    renderHook(() =>
      useRegistryServers({
        projectId: "project-1",
        isAuthenticated: true,
        liveServers: {},
        onConnect: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(mockGetExistingGuestBearerToken).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(registryHttp.mergeGuestRegistryStars).toHaveBeenCalledWith(
        "guest-bearer-1",
      );
    });

    await waitFor(() => {
      expect(mockClearGuestSession).toHaveBeenCalledTimes(1);
    });
  });

  it("does not call merge when there is no existing guest", async () => {
    mockGetExistingGuestBearerToken.mockResolvedValue(null);

    renderHook(() =>
      useRegistryServers({
        projectId: "project-1",
        isAuthenticated: true,
        liveServers: {},
        onConnect: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(mockGetExistingGuestBearerToken).toHaveBeenCalledTimes(1);
    });
    expect(registryHttp.mergeGuestRegistryStars).not.toHaveBeenCalled();
    expect(mockClearGuestSession).not.toHaveBeenCalled();
  });
});
