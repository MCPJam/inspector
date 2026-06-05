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

const captureMock = vi.fn();

vi.mock("@/hooks/usePaymentsHistory", () => ({
  usePaymentsHistory: () => hookState,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: captureMock }),
}));

function makeEntry(
  overrides: Partial<PaymentHistoryEntry> & { id: string }
): PaymentHistoryEntry {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId ?? `cs_${overrides.id}`,
    kind: overrides.kind ?? "credit_topup",
    pricePaidCents: overrides.pricePaidCents ?? 1000,
    displayCredits: overrides.displayCredits ?? "1,000 credits",
    description: overrides.description ?? "Credit top-up",
    ...(overrides.amountSubtitle !== undefined
      ? { amountSubtitle: overrides.amountSubtitle }
      : {}),
    status: overrides.status ?? "succeeded",
    occurredAt: overrides.occurredAt ?? Date.now(),
    ...(overrides.reversedPaidCents !== undefined
      ? { reversedPaidCents: overrides.reversedPaidCents }
      : {}),
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
    captureMock.mockReset();
  });

  describe("loading + empty states", () => {
    it("renders loading skeletons while the query is in flight", () => {
      render(<PaymentsHistorySection organizationId="org-1" canViewHistory />);
      expect(
        screen.getByTestId("payments-history-loading")
      ).toBeInTheDocument();
    });

    it("renders the empty state with no CTA when there are no entries", () => {
      // The empty state intentionally has no Top up button — the
      // CreditBalanceCard renders one directly above this section, so
      // duplicating it here would be visual noise.
      hookState = {
        entries: [],
        isLoading: false,
        isAuthenticated: true,
      };
      render(<PaymentsHistorySection organizationId="org-1" canViewHistory />);
      const empty = screen.getByTestId("payments-history-empty");
      expect(empty).toHaveTextContent(/No payments yet/);
      expect(within(empty).queryByRole("button")).not.toBeInTheDocument();
    });
  });

  describe("populated table", () => {
    const fixture: PaymentHistoryEntry[] = [
      makeEntry({
        id: "1",
        sessionId: "cs_succeeded_with_link",
        pricePaidCents: 2500,
        displayCredits: "2,500 credits",
        status: "succeeded",
        receiptUrl: "https://pay.stripe.com/receipts/abc",
        occurredAt: Date.UTC(2026, 4, 22),
      }),
      makeEntry({
        id: "2",
        sessionId: "cs_legacy_succeeded",
        pricePaidCents: 1000,
        displayCredits: "1,000 credits",
        status: "succeeded",
        occurredAt: Date.UTC(2026, 4, 14),
      }),
      makeEntry({
        id: "team-plan",
        sessionId: "org_1:period:team",
        kind: "team_plan",
        pricePaidCents: 7600,
        displayCredits: "12,000 credits",
        description: "Team plan included credits",
        amountSubtitle: "Catalog amount",
        status: "succeeded",
        occurredAt: Date.UTC(2026, 4, 12),
      }),
      makeEntry({
        id: "3",
        sessionId: "cs_pending",
        pricePaidCents: 5000,
        displayCredits: "5,000 credits",
        status: "pending",
        occurredAt: Date.UTC(2026, 4, 10),
      }),
      makeEntry({
        id: "4",
        sessionId: "cs_failed",
        pricePaidCents: 2500,
        displayCredits: "2,500 credits",
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
      render(<PaymentsHistorySection organizationId="org-1" canViewHistory />);
      // Each entry is rendered TWICE: once in the desktop table (sm+) and
      // once in the mobile stacked layout (<sm). Tailwind hides one via CSS
      // but jsdom doesn't apply CSS visibility, so getAllBy* returns both
      // copies. We assert the doubled count to lock in the dual-render.
      // Succeeded + URL → "View receipt" (1 entry × 2 layouts = 2 links)
      expect(
        screen.getAllByRole("link", { name: /View receipt/ })
      ).toHaveLength(2);
      // Succeeded + no URL → "Not available"
      expect(screen.getAllByText(/Not available/)).toHaveLength(4);
      // Pending → "Processing"
      expect(screen.getAllByText(/Processing/)).toHaveLength(2);
      // Failed → em-dash
      expect(screen.getAllByText("—")).toHaveLength(2);
    });

    it("renders the receipt link with full safety attributes", () => {
      render(<PaymentsHistorySection organizationId="org-1" canViewHistory />);
      const link = screen.getAllByRole("link", { name: /View receipt/ })[0];
      expect(link).toHaveAttribute(
        "href",
        "https://pay.stripe.com/receipts/abc"
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
      expect(link).toHaveAttribute("data-ph-no-capture");
      expect(link.getAttribute("aria-label")).toMatch(/opens in new tab/);
    });

    it("fires credit_topup_receipt_opened on receipt click (no URL prop, no status prop)", async () => {
      render(<PaymentsHistorySection organizationId="org-1" canViewHistory />);
      const link = screen.getAllByRole("link", { name: /View receipt/ })[0];
      await userEvent.click(link);
      const call = captureMock.mock.calls.find(
        (c) => c[0] === "credit_topup_receipt_opened"
      );
      expect(call).toBeDefined();
      const props = call?.[1] as Record<string, unknown>;
      expect(props).not.toHaveProperty("status");
      expect(props).not.toHaveProperty("receipt_url");
      expect(props).not.toHaveProperty("url");
      expect(typeof props.entry_age_days).toBe("number");
    });

    it("renders team plan rows with catalog amount context", () => {
      render(<PaymentsHistorySection organizationId="org-1" canViewHistory />);
      expect(screen.getAllByText("Team plan included credits")).toHaveLength(1);
      expect(screen.getAllByText("Catalog amount")).toHaveLength(2);
      expect(screen.getAllByText("$76")).toHaveLength(2);
      expect(
        screen.getByText(/Team plan included credits · 12,000 credits/)
      ).toBeInTheDocument();
    });

    it("fires credit_topup_history_viewed once with bucketed entry_count", () => {
      render(<PaymentsHistorySection organizationId="org-1" canViewHistory />);
      const calls = captureMock.mock.calls.filter(
        (c) => c[0] === "credit_topup_history_viewed"
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
      render(<PaymentsHistorySection organizationId="org-1" canViewHistory />);
      const calls = captureMock.mock.calls.filter(
        (c) => c[0] === "credit_topup_history_viewed"
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe("reversal statuses", () => {
    // Each entry renders twice (desktop table + mobile stack), so badge text
    // appears 2×. These statuses are the whole point of the fix: a refunded or
    // charged-back payment must NOT read as a plain green "Succeeded".
    function renderWithStatus(entry: PaymentHistoryEntry) {
      hookState = {
        entries: [entry],
        isLoading: false,
        isAuthenticated: true,
      };
      render(<PaymentsHistorySection organizationId="org-1" canViewHistory />);
    }

    it("renders a Refunded badge for a fully refunded payment", () => {
      renderWithStatus(
        makeEntry({
          id: "r1",
          status: "refunded",
          pricePaidCents: 500,
          reversedPaidCents: 500,
        })
      );
      expect(screen.getAllByText("Refunded")).toHaveLength(2);
      // Must not also read as Succeeded.
      expect(screen.queryByText("Succeeded")).not.toBeInTheDocument();
    });

    it("renders a Partially refunded badge with a reversed-amount tooltip", () => {
      renderWithStatus(
        makeEntry({
          id: "r2",
          status: "partially_refunded",
          pricePaidCents: 2500,
          reversedPaidCents: 1000,
        })
      );
      const badges = screen.getAllByText("Partially refunded");
      expect(badges).toHaveLength(2);
      // "$10 of $25 refunded" hover detail on the badge label.
      expect(badges[0]).toHaveAttribute("title", "$10 of $25 refunded");
    });

    it("renders a Disputed badge for a charged-back payment", () => {
      renderWithStatus(
        makeEntry({
          id: "r3",
          status: "disputed",
          pricePaidCents: 500,
          reversedPaidCents: 500,
        })
      );
      expect(screen.getAllByText("Disputed")).toHaveLength(2);
      expect(screen.queryByText("Succeeded")).not.toBeInTheDocument();
    });
  });
});
