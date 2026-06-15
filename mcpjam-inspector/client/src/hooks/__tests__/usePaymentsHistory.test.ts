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
  useQuery: (_name: unknown, args: unknown) =>
    args === "skip" ? undefined : queryReturn,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => workOsAuth,
}));

// Import AFTER mocks are set up.
import { usePaymentsHistory } from "../usePaymentsHistory";

// Billing is org-scoped, so the query only fires once an org is selected.
const ORG_ID = "org_test";

describe("usePaymentsHistory", () => {
  beforeEach(() => {
    convexAuth = { isAuthenticated: true, isLoading: false };
    workOsAuth = { user: { id: "u_test" }, isLoading: false };
    queryReturn = undefined;
  });

  describe("auth gating", () => {
    it("returns isLoading=true and entries=undefined while convex auth is loading", () => {
      convexAuth = { isAuthenticated: false, isLoading: true };
      const { result } = renderHook(() => usePaymentsHistory(ORG_ID));
      expect(result.current.isLoading).toBe(true);
      expect(result.current.entries).toBeUndefined();
    });

    it("returns isLoading=false and entries=undefined when unauthenticated (query is skipped)", () => {
      convexAuth = { isAuthenticated: false, isLoading: false };
      workOsAuth = { user: null, isLoading: false };
      const { result } = renderHook(() => usePaymentsHistory(ORG_ID));
      // Query is skipped so we don't wait on a response.
      expect(result.current.isLoading).toBe(false);
      expect(result.current.entries).toBeUndefined();
    });

    it("skips the query until an organization is selected", () => {
      const { result } = renderHook(() => usePaymentsHistory());
      // No org id -> query is skipped -> entries undefined, not loading.
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
            pricePaidCents: 2500,
            displayCredits: "2,500 credits",
            status: "succeeded",
            occurredAt: 100,
            receiptUrl: "https://pay.stripe.com/receipts/abc",
          },
        ],
      };
      const { result } = renderHook(() => usePaymentsHistory(ORG_ID));
      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries?.[0]).toEqual({
        id: "row_1",
        sessionId: "cs_1",
        pricePaidCents: 2500,
        displayCredits: "2,500 credits",
        details: "Credit top-up",
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
          pricePaidCents: 1000,
          displayCredits: "1,000 credits",
          status: "pending",
          occurredAt: 200,
        },
      ];
      const { result } = renderHook(() => usePaymentsHistory(ORG_ID));
      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries?.[0].status).toBe("pending");
      expect(result.current.entries?.[0].receiptUrl).toBeUndefined();
    });

    it("normalizes a seat refund row with account credit fallback fields", () => {
      queryReturn = {
        items: [
          {
            id: "seat_refund_1",
            sessionId: "seat-downgrade:sub:item:period:3->2",
            pricePaidCents: -35997,
            displayCredits: "-9,974 credits",
            details:
              "-1 Team seat · prorated · $300 card refund + $59.97 account credit",
            status: "refunded_and_credited",
            occurredAt: 300,
            reversedPaidCents: 30000,
            accountCreditedCents: 5997,
          },
        ],
      };
      const { result } = renderHook(() => usePaymentsHistory(ORG_ID));
      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries?.[0]).toMatchObject({
        id: "seat_refund_1",
        pricePaidCents: -35997,
        details:
          "-1 Team seat · prorated · $300 card refund + $59.97 account credit",
        status: "refunded_and_credited",
        accountCreditedCents: 5997,
      });
    });

    it("drops malformed rows but keeps valid neighbors", () => {
      queryReturn = {
        items: [
          {
            id: "good",
            sessionId: "cs_good",
            pricePaidCents: 100,
            displayCredits: "100 credits",
            status: "failed",
            occurredAt: 1,
          },
          {
            id: 123,
            sessionId: "cs_bad",
            pricePaidCents: 100,
            displayCredits: "100 credits",
            status: "failed",
            occurredAt: 1,
          },
          {
            id: "no_status",
            sessionId: "cs_n",
            pricePaidCents: 100,
            displayCredits: "100 credits",
            status: "weird",
            occurredAt: 1,
          },
        ],
      };
      const { result } = renderHook(() => usePaymentsHistory(ORG_ID));
      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries?.[0].id).toBe("good");
    });

    it("returns undefined when raw is not an array or envelope", () => {
      queryReturn = "not an array";
      const { result } = renderHook(() => usePaymentsHistory(ORG_ID));
      expect(result.current.entries).toBeUndefined();
    });

    it("drops empty-string receiptUrl rather than passing it through", () => {
      queryReturn = {
        items: [
          {
            id: "row",
            sessionId: "cs_e",
            pricePaidCents: 100,
            displayCredits: "100 credits",
            status: "succeeded",
            occurredAt: 1,
            receiptUrl: "",
          },
        ],
      };
      const { result } = renderHook(() => usePaymentsHistory(ORG_ID));
      expect(result.current.entries?.[0].receiptUrl).toBeUndefined();
    });
  });
});
