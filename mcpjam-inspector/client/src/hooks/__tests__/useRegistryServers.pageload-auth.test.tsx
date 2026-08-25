import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apis/web/base";
import * as registryHttp from "@/lib/apis/registry-http";
import { useRegistryServers } from "../useRegistryServers";

const { mockGetExistingGuestBearerToken, toastError } = vi.hoisted(() => ({
  mockGetExistingGuestBearerToken: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/apis/registry-http", () => ({
  fetchRegistryCatalog: vi.fn().mockResolvedValue([]),
  starRegistryCard: vi.fn(),
  unstarRegistryCard: vi.fn(),
  mergeGuestRegistryStars: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  track: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

vi.mock("@/lib/guest-session", () => ({
  getExistingGuestBearerToken: mockGetExistingGuestBearerToken,
  clearGuestSession: vi.fn(),
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

function bearerError() {
  return new WebApiError(
    401,
    "Missing or invalid bearer token",
    "Missing or invalid bearer token",
  );
}

describe("useRegistryServers pageload auth errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExistingGuestBearerToken.mockResolvedValue(null);
    vi.mocked(registryHttp.fetchRegistryCatalog).mockResolvedValue([]);
  });

  it("does not toast when the catalog 401s during auth bootstrap", async () => {
    vi.mocked(registryHttp.fetchRegistryCatalog).mockRejectedValueOnce(
      bearerError(),
    );

    renderHook(() =>
      useRegistryServers({
        projectId: "project-1",
        isAuthenticated: true,
        liveServers: {},
        onConnect: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(registryHttp.fetchRegistryCatalog).toHaveBeenCalled();
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("still toasts a non-auth catalog failure", async () => {
    vi.mocked(registryHttp.fetchRegistryCatalog).mockRejectedValueOnce(
      new WebApiError(500, "INTERNAL", "catalog exploded"),
    );

    renderHook(() =>
      useRegistryServers({
        projectId: "project-1",
        isAuthenticated: false,
        liveServers: {},
        onConnect: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("catalog exploded");
    });
  });

  it("does not toast when guest-star merge 401s on pageload", async () => {
    mockGetExistingGuestBearerToken.mockResolvedValue("guest-bearer-1");
    vi.mocked(registryHttp.mergeGuestRegistryStars).mockRejectedValue(
      bearerError(),
    );

    const { unmount } = renderHook(() =>
      useRegistryServers({
        projectId: "project-1",
        isAuthenticated: true,
        liveServers: {},
        onConnect: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(registryHttp.mergeGuestRegistryStars).toHaveBeenCalledWith(
        "guest-bearer-1",
      );
    });
    expect(toastError).not.toHaveBeenCalled();
    unmount();
  });

  it("does not toast or retry merge when the actor is a guest", async () => {
    mockGetExistingGuestBearerToken.mockResolvedValue("guest-bearer-1");
    vi.mocked(registryHttp.mergeGuestRegistryStars).mockRejectedValue(
      new WebApiError(401, "Signed-in user required", "Signed-in user required"),
    );

    renderHook(() =>
      useRegistryServers({
        projectId: "project-1",
        isAuthenticated: true,
        liveServers: {},
        onConnect: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(registryHttp.mergeGuestRegistryStars).toHaveBeenCalledTimes(1);
    });
    expect(toastError).not.toHaveBeenCalled();
  });
});
