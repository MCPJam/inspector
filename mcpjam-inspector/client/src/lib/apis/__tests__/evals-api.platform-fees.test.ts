import { beforeEach, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";

const authFetchMock = vi.fn();
vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));
vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));
vi.mock("@/lib/apis/web/context", () => ({
  buildServerBatchRequest: () => ({ projectId: "project", serverIds: [] }),
}));
import {
  rethrowIfBillingError,
  runEvals,
  streamEvalTestCase,
} from "../evals-api";

beforeEach(() => {
  vi.clearAllMocks();
  useMCPJamLimitDialogStore.setState({
    authStatus: "signedIn",
    hasPendingLimit: false,
    outOfCreditsHit: false,
    outOfCreditsOrganizationId: null,
    isOpen: false,
    intent: null,
    organizationId: null,
    pendingInput: null,
  });
});

it.each(["buffered", "streamed", "replay-boundary"] as const)(
  "preserves fee remedies on %s",
  async (path) => {
    const details = {
      code: "platform_fee_refused",
      reason: "insufficient_credits",
    };
    const envelope = {
      code: "PAYMENT_REQUIRED",
      message: "Add credits in Organization → Billing, then run it again.",
      details,
    };
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify(envelope), { status: 402 }),
    );
    const invoke =
      path === "buffered"
        ? () => runEvals({ projectId: "project", serverIds: [], tests: [] })
        : path === "streamed"
          ? () =>
              streamEvalTestCase(
                {
                  projectId: "project",
                  serverIds: [],
                  testCaseId: "case",
                  model: "openai/gpt-5-mini",
                  provider: "openai",
                },
                vi.fn(),
              )
          : async () => rethrowIfBillingError(envelope);
    let caught: unknown;
    try {
      await invoke();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect(caught).toMatchObject({
      data: { ...details, message: envelope.message },
    });
    expect(getBillingErrorMessage(caught, "Generic failure")).toBe(
      envelope.message,
    );
    expect(useMCPJamLimitDialogStore.getState()).toMatchObject({
      isOpen: true,
      intent: "topup",
    });
  },
);

it.each([
  "spend_budget_reached",
  "wallet_locked",
  "credits_reserved",
  "unknown",
  undefined,
])("does not sell credits for %s", (reason) => {
  const details = {
    code: "platform_fee_refused",
    ...(reason ? { reason } : {}),
    message:
      "Ask an admin to review billing. Insufficient credits are not the cause.",
  };
  expect(() =>
    rethrowIfBillingError({ code: "PAYMENT_REQUIRED", details }),
  ).toThrow(ConvexError);
  expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
});

it.each([
  "platform_fee_refused",
  "billing_limit_reached",
  "billing_feature_not_included",
])("prefers a domain remedy over the outer message for %s", (code) => {
  expect(() =>
    rethrowIfBillingError({
      message: "Outer remedy",
      details: { code, message: "Domain remedy" },
    }),
  ).toThrowError(
    expect.objectContaining({ data: { code, message: "Domain remedy" } }),
  );
});
it.each(["billing_limit_reached", "billing_feature_not_included"])(
  "preserves the outer legacy remedy for %s",
  (code) => {
    expect(() =>
      rethrowIfBillingError({ message: "Legacy remedy", details: { code } }),
    ).toThrowError(
      expect.objectContaining({ data: { code, message: "Legacy remedy" } }),
    );
  },
);
it("keeps a spend-budget response terminal without offering credits", () => {
  expect(() =>
    rethrowIfBillingError({
      message: "Ask an admin to raise the budget.",
      details: { code: "ORGANIZATION_SPEND_BUDGET_REACHED" },
    }),
  ).toThrow(ConvexError);
  expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
});
it("opens top-up for the refused organization", () => {
  expect(() =>
    rethrowIfBillingError({
      message: "Add credits.",
      details: {
        code: "platform_fee_refused",
        reason: "insufficient_credits",
        organizationId: "refused-org",
      },
    }),
  ).toThrow(ConvexError);
  expect(useMCPJamLimitDialogStore.getState()).toMatchObject({
    isOpen: true,
    organizationId: "refused-org",
    outOfCreditsOrganizationId: "refused-org",
  });
});
