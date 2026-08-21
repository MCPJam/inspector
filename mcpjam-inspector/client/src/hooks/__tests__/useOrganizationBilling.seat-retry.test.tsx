import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercises the retry/cancel race at the hook boundary rather than through a
// mocked component, so the real cancel-version bookkeeping runs.

const convexFns = vi.hoisted(() => ({
  retrySeatPayment: vi.fn(),
  startSeatPayment: vi.fn(),
  cancelSeatPayment: vi.fn(),
  completeSeatPayment: vi.fn(),
}));

const activeSeatPaymentIntent = {
  _id: "seat-payment-1",
  organizationId: "org-1",
  userId: "user-new",
  email: "stranded@example.com",
  role: "member" as const,
  source: "pending_invite_signup",
  status: "failed" as const,
  needsRetry: true,
  targetSeatQuantity: null,
  stripeInvoiceId: null,
  createdAt: 1,
  updatedAt: 2,
};

vi.mock("convex/react", () => ({
  useQuery: (name: string) =>
    name === "billing:getActiveOrganizationSeatPaymentIntent"
      ? activeSeatPaymentIntent
      : undefined,
  useMutation: (name: string) =>
    name === "billing:retrySeatPayment"
      ? convexFns.retrySeatPayment
      : vi.fn(),
  useAction: (name: string) => {
    if (name === "billing:startSeatPayment") return convexFns.startSeatPayment;
    if (name === "billing:cancelSeatPayment")
      return convexFns.cancelSeatPayment;
    if (name === "billing:completeSeatPayment")
      return convexFns.completeSeatPayment;
    return vi.fn();
  },
}));

vi.mock("@/lib/stripe-elements", () => ({
  confirmSeatPaymentWithStripe: vi.fn(),
}));

import { useOrganizationBilling } from "../useOrganizationBilling";

describe("useOrganizationBilling seat payment retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convexFns.cancelSeatPayment.mockResolvedValue(undefined);
    convexFns.startSeatPayment.mockResolvedValue({
      status: "paid",
      seatQuantity: 4,
    });
  });

  it("does not start payment when the charge is cancelled mid-retry", async () => {
    // Reopening the charge and starting payment are two round trips. Cancel
    // lands in between; finishSeatPayment's own guard reads the cancel version
    // at its own start, which is already too late to notice.
    let resolveRetry: (value: unknown) => void = () => {};
    convexFns.retrySeatPayment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve;
        })
    );

    const { result } = renderHook(() =>
      useOrganizationBilling({ organizationId: "org-1" })
    );

    let retryPromise: Promise<unknown> | undefined;
    act(() => {
      retryPromise = result.current.retrySeatPayment();
    });

    // Owner hits "Remove invite" while the charge is being reopened.
    await act(async () => {
      await result.current.cancelSeatPayment();
    });

    await act(async () => {
      resolveRetry({ restarted: true, seatPaymentIntentId: "seat-payment-1" });
      await retryPromise;
    });

    expect(convexFns.cancelSeatPayment).toHaveBeenCalledTimes(1);
    // The whole point: payment must not be reopened on a cancelled charge.
    expect(convexFns.startSeatPayment).not.toHaveBeenCalled();
  });

  it("starts payment normally when nothing cancels it", async () => {
    convexFns.retrySeatPayment.mockResolvedValue({
      restarted: true,
      seatPaymentIntentId: "seat-payment-1",
    });

    const { result } = renderHook(() =>
      useOrganizationBilling({ organizationId: "org-1" })
    );

    await act(async () => {
      await result.current.retrySeatPayment();
    });

    await waitFor(() =>
      expect(convexFns.startSeatPayment).toHaveBeenCalledTimes(1)
    );
  });

  it("surfaces an error when there is nothing left to retry", async () => {
    convexFns.retrySeatPayment.mockResolvedValue({
      restarted: false,
      seatPaymentIntentId: null,
    });

    const { result } = renderHook(() =>
      useOrganizationBilling({ organizationId: "org-1" })
    );

    await act(async () => {
      await expect(result.current.retrySeatPayment()).rejects.toThrow(
        "can no longer be retried"
      );
    });
    expect(convexFns.startSeatPayment).not.toHaveBeenCalled();
  });
});
