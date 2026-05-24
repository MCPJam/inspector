import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PaymentsHistorySection } from "../PaymentsHistorySection";
import type {
  PaymentHistoryEntry,
  UsePaymentsHistoryResult,
} from "@/hooks/usePaymentsHistory";

let hookState: UsePaymentsHistoryResult = {
  entries: undefined,
  isLoading: true,
  isAuthenticated: false,
};

let flagState: boolean | undefined = true;
const captureMock = vi.fn();

vi.mock("@/hooks/usePaymentsHistory", () => ({
  usePaymentsHistory: () => hookState,
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "billing-entitlements-ui" ? flagState : false,
  usePostHog: () => ({ capture: captureMock }),
}));

// The empty-state CTA opens CreditTopupDialog; stub it so we don't drag
// Convex + the topup hook stack into this test.
vi.mock("@/components/billing/CreditTopupDialog", () => ({
  CreditTopupDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="stub-topup-dialog" /> : null,
}));

function makeEntry(
  overrides: Partial<PaymentHistoryEntry> & { id: string },
): PaymentHistoryEntry {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId ?? `cs_${overrides.id}`,
    paidAmountCents: overrides.paidAmountCents ?? 1000,
    status: overrides.status ?? "succeeded",
    occurredAt: overrides.occurredAt ?? Date.now(),
    ...(overrides.receiptUrl !== undefined
      ? { receiptUrl: overrides.receiptUrl }
      : {}),
  };
}

describe("PaymentsHistorySection", () => {
  beforeEach(() => {
    hookState = {
      entries: undefined,
      isLoading: true,
      isAuthenticated: false,
    };
    flagState = true;
    captureMock.mockReset();
  });

  describe("flag gating", () => {
    it("renders nothing when the flag is off", () => {
      flagState = false;
      const { container } = render(<PaymentsHistorySection />);
      expect(container.firstChild).toBeNull();
    });

    it("renders nothing when the flag is still undefined (bootstrap window)", () => {
      flagState = undefined;
      const { container } = render(<PaymentsHistorySection />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe("loading + empty states", () => {
    it("renders loading skeletons while the query is in flight", () => {
      render(<PaymentsHistorySection />);
      expect(screen.getByTestId("payments-history-loading")).toBeInTheDocument();
    });

    it("renders the empty state with a Top up CTA when there are no entries", async () => {
      hookState = {
        entries: [],
        isLoading: false,
        isAuthenticated: true,
      };
      render(<PaymentsHistorySection />);
      const empty = screen.getByTestId("payments-history-empty");
      expect(empty).toHaveTextContent(/No payments yet/);
      const cta = within(empty).getByRole("button", { name: /Top up/ });
      await userEvent.click(cta);
      expect(captureMock).toHaveBeenCalledWith("credit_topup_cta_clicked", {
        source: "history_empty_state",
      });
      // CTA opens the stubbed dialog
      expect(screen.getByTestId("stub-topup-dialog")).toBeInTheDocument();
    });
  });

  describe("populated table", () => {
    const fixture: PaymentHistoryEntry[] = [
      makeEntry({
        id: "1",
        sessionId: "cs_succeeded_with_link",
        paidAmountCents: 2500,
        status: "succeeded",
        receiptUrl: "https://pay.stripe.com/receipts/abc",
        occurredAt: Date.UTC(2026, 4, 22),
      }),
      makeEntry({
        id: "2",
        sessionId: "cs_legacy_succeeded",
        paidAmountCents: 1000,
        status: "succeeded",
        occurredAt: Date.UTC(2026, 4, 14),
      }),
      makeEntry({
        id: "3",
        sessionId: "cs_pending",
        paidAmountCents: 5000,
        status: "pending",
        occurredAt: Date.UTC(2026, 4, 10),
      }),
      makeEntry({
        id: "4",
        sessionId: "cs_failed",
        paidAmountCents: 2500,
        status: "failed",
        occurredAt: Date.UTC(2026, 4, 3),
      }),
    ];

    beforeEach(() => {
      hookState = {
        entries: fixture,
        isLoading: false,
        isAuthenticated: true,
      };
    });

    it("renders one row per entry with status-appropriate receipt copy", () => {
      render(<PaymentsHistorySection />);
      // Succeeded + URL → "View receipt"
      expect(
        screen.getAllByRole("link", { name: /View receipt/ }),
      ).toHaveLength(1);
      // Succeeded + no URL → "Not available"
      expect(screen.getAllByText(/Not available/)[0]).toBeInTheDocument();
      // Pending → "Processing"
      expect(screen.getAllByText(/Processing/)[0]).toBeInTheDocument();
      // Failed → em-dash
      expect(screen.getAllByText("—")[0]).toBeInTheDocument();
    });

    it("renders the receipt link with full safety attributes", () => {
      render(<PaymentsHistorySection />);
      const link = screen.getAllByRole("link", { name: /View receipt/ })[0];
      expect(link).toHaveAttribute(
        "href",
        "https://pay.stripe.com/receipts/abc",
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
      expect(link).toHaveAttribute("data-ph-no-capture");
      expect(link.getAttribute("aria-label")).toMatch(/opens in new tab/);
    });

    it("fires credit_topup_receipt_opened on receipt click (no URL prop, no status prop)", async () => {
      render(<PaymentsHistorySection />);
      const link = screen.getAllByRole("link", { name: /View receipt/ })[0];
      await userEvent.click(link);
      const call = captureMock.mock.calls.find(
        (c) => c[0] === "credit_topup_receipt_opened",
      );
      expect(call).toBeDefined();
      const props = call?.[1] as Record<string, unknown>;
      expect(props).not.toHaveProperty("status");
      expect(props).not.toHaveProperty("receipt_url");
      expect(props).not.toHaveProperty("url");
      expect(typeof props.entry_age_days).toBe("number");
    });

    it("fires credit_topup_history_viewed once with bucketed entry_count", () => {
      render(<PaymentsHistorySection />);
      const calls = captureMock.mock.calls.filter(
        (c) => c[0] === "credit_topup_history_viewed",
      );
      expect(calls).toHaveLength(1);
      const props = calls[0][1] as Record<string, unknown>;
      expect(props.entry_count_bucket).toBe("2-5");
      expect(props.has_failed).toBe(true);
      expect(props.has_pending).toBe(true);
    });

    it("does not fire credit_topup_history_viewed when there are zero entries", () => {
      hookState = {
        entries: [],
        isLoading: false,
        isAuthenticated: true,
      };
      render(<PaymentsHistorySection />);
      const calls = captureMock.mock.calls.filter(
        (c) => c[0] === "credit_topup_history_viewed",
      );
      expect(calls).toHaveLength(0);
    });
  });
});
