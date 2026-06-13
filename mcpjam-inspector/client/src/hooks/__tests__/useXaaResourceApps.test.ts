import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Mocks ──────────────────────────────────────────────────────────────
let convexAuth = { isAuthenticated: true, isLoading: false };
let queryReturn: unknown = undefined;
let hostedMode = true;
const upsertAction = vi.fn(async () => ({ id: "app_new" }));
const removeAction = vi.fn(async () => undefined);
let lastQueryArgs: unknown;

vi.mock("convex/react", () => ({
  useConvexAuth: () => convexAuth,
  useQuery: (_name: unknown, args: unknown) => {
    lastQueryArgs = args;
    return args === "skip" ? undefined : queryReturn;
  },
  useAction: (name: unknown) =>
    name === "xaaResourceApps:upsert" ? upsertAction : removeAction,
}));

vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return hostedMode;
  },
}));

// Import AFTER mocks are set up.
import { useXaaResourceApps } from "../useXaaResourceApps";

const ORG_ID = "org_test";

const VALID_ROW = {
  id: "app_1",
  name: "My Resource",
  resourceType: "mcp",
  resourceUrl: "https://resource.example.com/mcp",
  authServerMode: "own",
  tokenEndpoint: "https://as.example.com/oauth/token",
  hasSecret: true,
  createdAt: 100,
  updatedAt: 200,
};

describe("useXaaResourceApps", () => {
  beforeEach(() => {
    convexAuth = { isAuthenticated: true, isLoading: false };
    queryReturn = undefined;
    hostedMode = true;
    lastQueryArgs = undefined;
    upsertAction.mockClear();
    removeAction.mockClear();
  });

  describe("auth + hosted gate", () => {
    it("fetches and reports isAuthenticated when authenticated, org-scoped, hosted", () => {
      queryReturn = { resourceApps: [VALID_ROW] };
      const { result } = renderHook(() => useXaaResourceApps(ORG_ID));
      expect(result.current.isAuthenticated).toBe(true);
      expect(lastQueryArgs).toEqual({ organizationId: ORG_ID });
      expect(result.current.resourceApps).toHaveLength(1);
    });

    it("skips the query and reports isAuthenticated=false when not hosted", () => {
      hostedMode = false;
      const { result } = renderHook(() => useXaaResourceApps(ORG_ID));
      expect(result.current.isAuthenticated).toBe(false);
      expect(lastQueryArgs).toBe("skip");
      expect(result.current.isLoading).toBe(false);
    });

    it("skips when unauthenticated", () => {
      convexAuth = { isAuthenticated: false, isLoading: false };
      const { result } = renderHook(() => useXaaResourceApps(ORG_ID));
      expect(result.current.isAuthenticated).toBe(false);
      expect(lastQueryArgs).toBe("skip");
    });

    it("skips when no organization is selected", () => {
      const { result } = renderHook(() => useXaaResourceApps(null));
      expect(result.current.isAuthenticated).toBe(false);
      expect(lastQueryArgs).toBe("skip");
    });

    it("reports isLoading while the gated query is in flight", () => {
      queryReturn = undefined; // query returns undefined => still loading
      const { result } = renderHook(() => useXaaResourceApps(ORG_ID));
      expect(result.current.isLoading).toBe(true);
    });

    it("reports isLoading during the auth-bootstrap window (hosted)", () => {
      convexAuth = { isAuthenticated: false, isLoading: true };
      const { result } = renderHook(() => useXaaResourceApps(ORG_ID));
      expect(result.current.isLoading).toBe(true);
      expect(result.current.isAuthenticated).toBe(false);
    });
  });

  describe("normalize", () => {
    it("accepts a bare array as well as a wrapped envelope", () => {
      queryReturn = [VALID_ROW];
      const { result } = renderHook(() => useXaaResourceApps(ORG_ID));
      expect(result.current.resourceApps).toHaveLength(1);
      expect(result.current.resourceApps[0]).toMatchObject({
        id: "app_1",
        resourceType: "mcp",
        authServerMode: "own",
        hasSecret: true,
      });
    });

    it("drops malformed rows (bad enum / missing id)", () => {
      queryReturn = {
        resourceApps: [
          VALID_ROW,
          { ...VALID_ROW, id: "app_2", resourceType: "grpc" },
          { ...VALID_ROW, id: undefined },
        ],
      };
      const { result } = renderHook(() => useXaaResourceApps(ORG_ID));
      expect(result.current.resourceApps).toHaveLength(1);
      expect(result.current.resourceApps[0].id).toBe("app_1");
    });

    it("never surfaces a secret value even if the wire carried one", () => {
      queryReturn = {
        resourceApps: [{ ...VALID_ROW, secret: "leaked", vaultObjectId: "v" }],
      };
      const { result } = renderHook(() => useXaaResourceApps(ORG_ID));
      const app = result.current.resourceApps[0] as Record<string, unknown>;
      expect(app).not.toHaveProperty("secret");
      expect(app).not.toHaveProperty("vaultObjectId");
    });
  });

  describe("mutations", () => {
    it("upsert forwards organizationId and the input", async () => {
      const { result } = renderHook(() => useXaaResourceApps(ORG_ID));
      await act(async () => {
        await result.current.upsert({
          name: "New",
          resourceType: "rest",
          resourceUrl: "https://r.example.com/api",
          authServerMode: "mcpjam",
        });
      });
      expect(upsertAction).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          name: "New",
          authServerMode: "mcpjam",
        }),
      );
    });

    it("remove forwards id + organizationId", async () => {
      const { result } = renderHook(() => useXaaResourceApps(ORG_ID));
      await act(async () => {
        await result.current.remove("app_1");
      });
      expect(removeAction).toHaveBeenCalledWith({
        id: "app_1",
        organizationId: ORG_ID,
      });
    });

    it("captures the error message when a mutation throws", async () => {
      upsertAction.mockRejectedValueOnce(new Error("boom"));
      const { result } = renderHook(() => useXaaResourceApps(ORG_ID));
      await act(async () => {
        await expect(
          result.current.upsert({
            name: "x",
            resourceType: "rest",
            resourceUrl: "https://r.example.com/api",
            authServerMode: "mcpjam",
          }),
        ).rejects.toThrow("boom");
      });
      expect(result.current.error).toBe("boom");
    });
  });
});
