import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: vi.fn(),
}));

import { resolveConvexAccessToken } from "../resolve-convex-access-token";
import { getGuestBearerToken } from "@/lib/guest-session";

describe("resolveConvexAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGuestBearerToken).mockResolvedValue("guest-token");
  });

  it("returns the WorkOS token for signed-in users without touching guest auth", async () => {
    const token = await resolveConvexAccessToken({
      getWorkosAccessToken: async () => "workos-token",
      hasWorkosUser: true,
    });

    expect(token).toBe("workos-token");
    expect(getGuestBearerToken).not.toHaveBeenCalled();
  });

  it("falls back to the guest bearer when there is no WorkOS user", async () => {
    const token = await resolveConvexAccessToken({
      getWorkosAccessToken: async () => null,
      hasWorkosUser: false,
    });

    expect(token).toBe("guest-token");
  });

  it("falls back to the guest bearer when the WorkOS getter throws for a guest", async () => {
    const token = await resolveConvexAccessToken({
      getWorkosAccessToken: async () => {
        throw new Error("LoginRequiredError");
      },
      hasWorkosUser: false,
    });

    expect(token).toBe("guest-token");
  });

  it("never downgrades a signed-in user to a guest bearer if their token fails", async () => {
    const token = await resolveConvexAccessToken({
      getWorkosAccessToken: async () => {
        throw new Error("transient");
      },
      hasWorkosUser: true,
    });

    expect(token).toBeNull();
    expect(getGuestBearerToken).not.toHaveBeenCalled();
  });

  it("returns null for a signed-in user whose token resolves empty", async () => {
    const token = await resolveConvexAccessToken({
      getWorkosAccessToken: async () => "",
      hasWorkosUser: true,
    });

    expect(token).toBeNull();
    expect(getGuestBearerToken).not.toHaveBeenCalled();
  });
});
