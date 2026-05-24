import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// ── Mocks ──────────────────────────────────────────────────────────────
let convexAuth = { isAuthenticated: true, isLoading: false };
let workOsAuth: { user: unknown; isLoading: boolean } = {
  user: { id: "u_test" },
  isLoading: false,
};
let queryReturn: unknown = undefined;

vi.mock("convex/react", () => ({
  useConvexAuth: () => convexAuth,
  useQuery: (..._args: unknown[]) => queryReturn,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => workOsAuth,
}));

// Import AFTER mocks are set up.
import { usePaymentsHistory } from "../usePaymentsHistory";

describe("usePaymentsHistory", () => {
  beforeEach(() => {
    convexAuth = { isAuthenticated: true, isLoading: false };
    workOsAuth = { user: { id: "u_test" }, isLoading: false };
    queryReturn = undefined;
  });

  describe("auth gating", () => {
    it("returns isLoading=true and entries=undefined while convex auth is loading", () => {
      convexAuth = { isAuthenticated: false, isLoading: true };
      const { result } = renderHook(() => usePaymentsHistory());
      expect(result.current.isLoading).toBe(true);
      expect(result.current.entries).toBeUndefined();
    });

    it("returns isLoading=false and entries=undefined when unauthenticated (query is skipped)", () => {
      convexAuth = { isAuthenticated: false, isLoading: false };
      workOsAuth = { user: null, isLoading: false };
      const { result } = renderHook(() => usePaymentsHistory());
      // Query is skipped so we don't wait on a response.
      expect(result.current.isLoading).toBe(false);
      expect(result.current.entries).toBeUndefined();
    });
  });

  describe("normalize", () => {
    it("normalizes a well-formed { items: [...] } envelope", () => {
      queryReturn = {
        items: [
          {
            id: "row_1",
            sessionId: "cs_1",
            paidAmountCents: 2500,
            status: "succeeded",
            occurredAt: 100,
            receiptUrl: "https://pay.stripe.com/receipts/abc",
          },
        ],
      };
      const { result } = renderHook(() => usePaymentsHistory());
      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries?.[0]).toEqual({
        id: "row_1",
        sessionId: "cs_1",
        paidAmountCents: 2500,
        status: "succeeded",
        occurredAt: 100,
        receiptUrl: "https://pay.stripe.com/receipts/abc",
      });
    });

    it("accepts a bare array (no envelope)", () => {
      queryReturn = [
        {
          id: "row_2",
          sessionId: "cs_2",
          paidAmountCents: 1000,
          status: "pending",
          occurredAt: 200,
        },
      ];
      const { result } = renderHook(() => usePaymentsHistory());
      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries?.[0].status).toBe("pending");
      expect(result.current.entries?.[0].receiptUrl).toBeUndefined();
    });

    it("drops malformed rows but keeps valid neighbors", () => {
      queryReturn = {
        items: [
          { id: "good", sessionId: "cs_good", paidAmountCents: 100, status: "failed", occurredAt: 1 },
          { id: 123, sessionId: "cs_bad", paidAmountCents: 100, status: "failed", occurredAt: 1 },
          { id: "no_status", sessionId: "cs_n", paidAmountCents: 100, status: "weird", occurredAt: 1 },
        ],
      };
      const { result } = renderHook(() => usePaymentsHistory());
      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries?.[0].id).toBe("good");
    });

    it("returns undefined when raw is not an array or envelope", () => {
      queryReturn = "not an array";
      const { result } = renderHook(() => usePaymentsHistory());
      expect(result.current.entries).toBeUndefined();
    });

    it("drops empty-string receiptUrl rather than passing it through", () => {
      queryReturn = {
        items: [
          {
            id: "row",
            sessionId: "cs_e",
            paidAmountCents: 100,
            status: "succeeded",
            occurredAt: 1,
            receiptUrl: "",
          },
        ],
      };
      const { result } = renderHook(() => usePaymentsHistory());
      expect(result.current.entries?.[0].receiptUrl).toBeUndefined();
    });
  });
});
