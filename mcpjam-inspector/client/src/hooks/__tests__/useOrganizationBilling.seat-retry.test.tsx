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
const stripeFns = vi.hoisted(() => ({
  confirmSeatPaymentWithStripe: vi.fn(),
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

vi.mock("@/lib/seat-payment-stripe", () => stripeFns);

import { useOrganizationBilling } from "../useOrganizationBilling";

describe("useOrganizationBilling seat payment retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convexFns.cancelSeatPayment.mockResolvedValue({
      voided: true,
      outcome: "canceled",
    });
    convexFns.startSeatPayment.mockResolvedValue({
      status: "paid",
      seatQuantity: 4,
    });
    stripeFns.confirmSeatPaymentWithStripe.mockResolvedValue(undefined);
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

    const { result } = renderHook(() => useOrganizationBilling("org-1"));

    let retryPromise: Promise<unknown> | undefined;
    act(() => {
      retryPromise = result.current.retrySeatPayment();
    });

    // Owner hits Cancel while the charge is being reopened. Note this is the
    // cancelSeatPayment path, which the button uses once a retry has made the
    // charge active again. The separate "Remove invite" action on a terminal
    // charge calls removeMember instead, and is fenced server-side by
    // removeMember terminalizing the intent in its own transaction — a client
    // ref could not cover that anyway, since the owner may have two tabs open.
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

    const { result } = renderHook(() => useOrganizationBilling("org-1"));

    await act(async () => {
      await result.current.retrySeatPayment();
    });

    await waitFor(() =>
      expect(convexFns.startSeatPayment).toHaveBeenCalledTimes(1)
    );
  });

  it("returns the backend cancellation outcome", async () => {
    convexFns.cancelSeatPayment.mockResolvedValue({
      voided: false,
      outcome: "deferred",
    });

    const { result } = renderHook(() => useOrganizationBilling("org-1"));

    await expect(result.current.cancelSeatPayment()).resolves.toEqual({
      voided: false,
      outcome: "deferred",
    });
  });

  it("marks browser confirmation failures for cleanup before retry", async () => {
    convexFns.startSeatPayment.mockResolvedValue({
      status: "requires_action",
      clientSecret: "cs_declined",
      publishableKey: "pk_test",
      stripeInvoiceId: "in_declined",
      seatQuantity: 4,
    });
    stripeFns.confirmSeatPaymentWithStripe.mockRejectedValue(
      new Error("Your card was declined")
    );

    const { result } = renderHook(() => useOrganizationBilling("org-1"));

    await act(async () => {
      await expect(result.current.finishSeatPayment()).rejects.toThrow(
        "Your card was declined"
      );
    });
    expect(convexFns.cancelSeatPayment).toHaveBeenCalledWith({
      organizationId: "org-1",
      seatPaymentIntentId: "seat-payment-1",
      stripeInvoiceId: "in_declined",
      terminalStatus: "failed",
    });
  });

  it("surfaces an error when there is nothing left to retry", async () => {
    convexFns.retrySeatPayment.mockResolvedValue({
      restarted: false,
      seatPaymentIntentId: null,
    });

    const { result } = renderHook(() => useOrganizationBilling("org-1"));

    await act(async () => {
      await expect(result.current.retrySeatPayment()).rejects.toThrow(
        "can no longer be retried"
      );
    });
    expect(convexFns.startSeatPayment).not.toHaveBeenCalled();
  });
});
