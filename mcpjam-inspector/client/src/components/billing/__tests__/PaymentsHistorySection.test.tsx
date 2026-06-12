import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PaymentsHistorySection } from "../PaymentsHistorySection";
import type {
  PaymentHistoryEntry,
  UsePaymentsHistoryResult,
} from "@/hooks/usePaymentsHistory";
import type {
  InvoiceHistoryEntry,
  UseInvoiceHistoryResult,
} from "@/hooks/useInvoiceHistory";
import type { CreditActivityEntry } from "@/hooks/useCreditActivity";

let hookState: UsePaymentsHistoryResult = {
  entries: undefined,
  isLoading: true,
  isAuthenticated: false,
};
let invoiceHookState: UseInvoiceHistoryResult = {
  entries: [],
  upcoming: null,
  isLoading: false,
  error: null,
};
let creditActivityHookState: {
  entries: CreditActivityEntry[] | undefined;
  isLoading: boolean;
} = {
  entries: [],
  isLoading: false,
};

const captureMock = vi.fn();

vi.mock("@/hooks/usePaymentsHistory", () => ({
  usePaymentsHistory: () => hookState,
}));

// Invoices come from a separate Stripe-backed hook; these tests cover the
// top-up path, so stub it empty (its own behavior is exercised elsewhere).
vi.mock("@/hooks/useInvoiceHistory", () => ({
  useInvoiceHistory: () => invoiceHookState,
}));

vi.mock("@/hooks/useCreditActivity", () => ({
  useCreditActivity: () => creditActivityHookState,
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
    pricePaidCents: overrides.pricePaidCents ?? 1000,
    displayCredits: overrides.displayCredits ?? "1,000 credits",
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
    invoiceHookState = {
      entries: [],
      upcoming: null,
      isLoading: false,
      error: null,
    };
    creditActivityHookState = {
      entries: [],
      isLoading: false,
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
      expect(screen.getAllByText(/Not available/)).toHaveLength(2);
      // Pending → "Processing"
      expect(screen.getAllByText(/Processing/)).toHaveLength(2);
      // Failed -> placeholder
      expect(screen.getAllByText("-")).toHaveLength(2);
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
      expect(screen.queryByText("Paid")).not.toBeInTheDocument();
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
      expect(screen.queryByText("Paid")).not.toBeInTheDocument();
    });
  });

  describe("billing rows", () => {
    it("collapses Stripe proration lines into a simple seat-change detail", () => {
      hookState = {
        entries: [],
        isLoading: false,
        isAuthenticated: true,
      };
      invoiceHookState = {
        entries: [
          {
            id: "in_prorated",
            createdAt: Date.UTC(2026, 5, 10),
            status: "paid",
            amountDueCents: 35997,
            amountPaidCents: 35997,
            currency: "usd",
            hostedInvoiceUrl: "https://billing.stripe.com/invoice",
            lines: [
              {
                description: "Unused time on MCPJam Team after 11 Jun 2026",
                amountCents: -35997,
                quantity: 1,
              },
              {
                description:
                  "Remaining time on 2 × MCPJam Team after 11 Jun 2026",
                amountCents: 71994,
                quantity: 2,
              },
            ],
          } satisfies InvoiceHistoryEntry,
        ],
        upcoming: null,
        isLoading: false,
        error: null,
      };

      render(<PaymentsHistorySection organizationId="org-1" canViewInvoices />);

      expect(screen.getAllByText("+1 Team seat · prorated")).toHaveLength(2);
      expect(screen.getAllByText("$359.97")).toHaveLength(2);
      expect(
        screen.queryByText(/Unused time on MCPJam Team/)
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Remaining time on 2/)).not.toBeInTheDocument();
    });

    it("folds granted credits into the matching paid invoice row", () => {
      hookState = {
        entries: [],
        isLoading: false,
        isAuthenticated: true,
      };
      invoiceHookState = {
        entries: [
          {
            id: "in_prorated",
            createdAt: Date.UTC(2026, 5, 10),
            status: "paid",
            amountDueCents: 35997,
            amountPaidCents: 35997,
            currency: "usd",
            hostedInvoiceUrl: "https://billing.stripe.com/invoice",
            lines: [
              {
                description: "Unused time on MCPJam Team after 11 Jun 2026",
                amountCents: -35997,
                quantity: 1,
              },
              {
                description:
                  "Remaining time on 2 × MCPJam Team after 11 Jun 2026",
                amountCents: 71994,
                quantity: 2,
              },
            ],
          } satisfies InvoiceHistoryEntry,
        ],
        upcoming: null,
        isLoading: false,
        error: null,
      };
      creditActivityHookState = {
        entries: [
          {
            id: "credit_1",
            createdAt: Date.UTC(2026, 5, 10, 0, 2),
            amountCredits: 12903,
            seatDelta: 1,
            kind: "granted",
            label: "Seat added (prorated)",
          },
        ],
        isLoading: false,
      };

      render(
        <PaymentsHistorySection
          organizationId="org-1"
          canViewInvoices
          canViewCreditActivity
        />
      );

      expect(screen.getAllByText("$359.97")).toHaveLength(2);
      expect(screen.getAllByText("+1 Team seat · prorated")).toHaveLength(2);
      expect(screen.getAllByText("+12,903")).toHaveLength(2);
      expect(screen.getAllByText("Paid")).toHaveLength(2);
      expect(screen.queryByText("Granted")).not.toBeInTheDocument();
    });

    it("does not aggregate multiple same-day grants into one invoice row", () => {
      hookState = {
        entries: [],
        isLoading: false,
        isAuthenticated: true,
      };
      invoiceHookState = {
        entries: [
          {
            id: "in_first",
            createdAt: Date.UTC(2026, 5, 10, 0, 1),
            status: "paid",
            amountDueCents: 35968,
            amountPaidCents: 35968,
            currency: "usd",
            lines: [
              {
                description: "Unused time on MCPJam Team after 11 Jun 2026",
                amountCents: -35968,
                quantity: 1,
              },
              {
                description:
                  "Remaining time on 2 × MCPJam Team after 11 Jun 2026",
                amountCents: 71936,
                quantity: 2,
              },
            ],
          },
          {
            id: "in_second",
            createdAt: Date.UTC(2026, 5, 10, 0, 4),
            status: "paid",
            amountDueCents: 35967,
            amountPaidCents: 35967,
            currency: "usd",
            lines: [
              {
                description: "Unused time on MCPJam Team after 11 Jun 2026",
                amountCents: -35967,
                quantity: 1,
              },
              {
                description:
                  "Remaining time on 2 × MCPJam Team after 11 Jun 2026",
                amountCents: 71934,
                quantity: 2,
              },
            ],
          },
        ],
        upcoming: null,
        isLoading: false,
        error: null,
      };
      creditActivityHookState = {
        entries: [
          {
            id: "credit_first",
            createdAt: Date.UTC(2026, 5, 10, 0, 1, 30),
            amountCredits: 9990,
            seatDelta: 1,
            kind: "granted",
            label: "Seat added (prorated)",
          },
          {
            id: "credit_second",
            createdAt: Date.UTC(2026, 5, 10, 0, 4, 30),
            amountCredits: 9889,
            seatDelta: 1,
            kind: "granted",
            label: "Seat added (prorated)",
          },
        ],
        isLoading: false,
      };

      render(
        <PaymentsHistorySection
          organizationId="org-1"
          canViewInvoices
          canViewCreditActivity
        />
      );

      expect(screen.getAllByText("+9,990")).toHaveLength(2);
      expect(screen.getAllByText("+9,889")).toHaveLength(2);
      expect(screen.queryByText("+19,879")).not.toBeInTheDocument();
      expect(screen.queryByText("Granted")).not.toBeInTheDocument();
    });

    it("folds clawed credits into the matching paid seat-removal invoice row", () => {
      hookState = {
        entries: [],
        isLoading: false,
        isAuthenticated: true,
      };
      invoiceHookState = {
        entries: [
          {
            id: "in_prorated_removal",
            createdAt: Date.UTC(2026, 5, 10),
            status: "paid",
            totalCents: -35997,
            amountDueCents: 0,
            amountPaidCents: 0,
            currency: "usd",
            hostedInvoiceUrl: "https://billing.stripe.com/invoice-removal",
            lines: [
              {
                description: "Unused time on 2 × MCPJam Team after 11 Jun 2026",
                amountCents: -35997,
                quantity: 2,
              },
              {
                description: "Remaining time on MCPJam Team after 11 Jun 2026",
                amountCents: 35997,
                quantity: 1,
              },
            ],
          } satisfies InvoiceHistoryEntry,
        ],
        upcoming: null,
        isLoading: false,
        error: null,
      };
      creditActivityHookState = {
        entries: [
          {
            id: "claw_1",
            createdAt: Date.UTC(2026, 5, 10, 0, 2),
            amountCredits: -9974,
            seatDelta: -1,
            kind: "clawed",
            label: "Seat removed (clawed back)",
          },
        ],
        isLoading: false,
      };

      render(
        <PaymentsHistorySection
          organizationId="org-1"
          canViewInvoices
          canViewCreditActivity
        />
      );

      expect(screen.getAllByText("$359.97 credit")).toHaveLength(2);
      expect(screen.getAllByText("-1 Team seat · prorated")).toHaveLength(2);
      expect(screen.getAllByText("-9,974")).toHaveLength(2);
      expect(screen.getAllByText("Credited")).toHaveLength(2);
      expect(screen.getAllByText("Stripe balance")).toHaveLength(2);
      expect(screen.queryByText("Clawed back")).not.toBeInTheDocument();
    });

    it("hides void Stripe invoices from payment history", () => {
      hookState = {
        entries: [],
        isLoading: false,
        isAuthenticated: true,
      };
      invoiceHookState = {
        entries: [
          {
            id: "in_void",
            createdAt: Date.UTC(2026, 5, 10),
            status: "void",
            amountDueCents: 35968,
            amountPaidCents: 0,
            currency: "usd",
            hostedInvoiceUrl: "https://billing.stripe.com/invoice-void",
            lines: [
              {
                description:
                  "Remaining time on 2 × MCPJam Team after 11 Jun 2026",
                amountCents: 35968,
                quantity: 2,
              },
            ],
          } satisfies InvoiceHistoryEntry,
        ],
        upcoming: null,
        isLoading: false,
        error: null,
      };

      render(<PaymentsHistorySection organizationId="org-1" canViewInvoices />);

      expect(screen.getByTestId("payments-history-empty")).toBeInTheDocument();
      expect(screen.queryByText("void")).not.toBeInTheDocument();
      expect(screen.queryByText("$359.68")).not.toBeInTheDocument();
    });

    it("hides unmatched credit activity when invoice history is visible", () => {
      hookState = {
        entries: [],
        isLoading: false,
        isAuthenticated: true,
      };
      invoiceHookState = {
        entries: [
          {
            id: "in_paid",
            createdAt: Date.UTC(2026, 5, 10),
            status: "paid",
            amountDueCents: 36000,
            amountPaidCents: 36000,
            currency: "usd",
            lines: [
              {
                description: "1 × MCPJam Team (at $360.00 / year)",
                amountCents: 36000,
                quantity: 1,
              },
            ],
          } satisfies InvoiceHistoryEntry,
        ],
        upcoming: null,
        isLoading: false,
        error: null,
      };
      creditActivityHookState = {
        entries: [
          {
            id: "credit_unmatched",
            createdAt: Date.UTC(2026, 5, 10, 0, 2),
            amountCredits: 9990,
            seatDelta: 1,
            kind: "granted",
            label: "Seat added (prorated)",
          },
          {
            id: "claw_unmatched",
            createdAt: Date.UTC(2026, 5, 10, 0, 3),
            amountCredits: -9990,
            seatDelta: -1,
            kind: "clawed",
            label: "Seat removed (clawed back)",
          },
        ],
        isLoading: false,
      };

      render(
        <PaymentsHistorySection
          organizationId="org-1"
          canViewInvoices
          canViewCreditActivity
        />
      );

      expect(screen.getAllByText("$360")).toHaveLength(2);
      expect(screen.queryByText("+9,990")).not.toBeInTheDocument();
      expect(screen.queryByText("-9,990")).not.toBeInTheDocument();
      expect(screen.queryByText("Granted")).not.toBeInTheDocument();
      expect(screen.queryByText("Clawed back")).not.toBeInTheDocument();
    });

    it("renders unmatched credit activity inside payment history", () => {
      hookState = {
        entries: [],
        isLoading: false,
        isAuthenticated: true,
      };
      creditActivityHookState = {
        entries: [
          {
            id: "credit_1",
            createdAt: Date.UTC(2026, 5, 10),
            amountCredits: 12903,
            seatDelta: 1,
            kind: "granted",
            label: "Seat added (prorated)",
          },
        ],
        isLoading: false,
      };

      render(
        <PaymentsHistorySection organizationId="org-1" canViewCreditActivity />
      );

      expect(screen.getAllByText("+1 Team seat · prorated")).toHaveLength(2);
      expect(screen.getAllByText("+12,903")).toHaveLength(2);
      expect(screen.getAllByText("Granted")).toHaveLength(2);
    });
  });
});
