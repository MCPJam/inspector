import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { PendingCreditTopupsBanner } from "../PendingCreditTopupsBanner";
import type {
  PendingCreditTopup,
  UsePendingCreditTopupsResult,
} from "@/hooks/usePendingCreditTopups";

let hookState: UsePendingCreditTopupsResult = {
  topups: undefined,
  pending: undefined,
  failed: undefined,
  isLoading: true,
  isAuthenticated: false,
};

vi.mock("@/hooks/usePendingCreditTopups", () => ({
  usePendingCreditTopups: () => hookState,
}));

function makeTopup(
  overrides: Partial<PendingCreditTopup> & { id: string },
): PendingCreditTopup {
  return {
    id: overrides.id,
    stripeSessionId: overrides.stripeSessionId ?? `cs_${overrides.id}`,
    amountCents: overrides.amountCents ?? 1000,
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

describe("PendingCreditTopupsBanner", () => {
  beforeEach(() => {
    hookState = {
      topups: undefined,
      pending: undefined,
      failed: undefined,
      isLoading: true,
      isAuthenticated: false,
    };
  });

  it("renders nothing while the query is loading (no flash of empty UI)", () => {
    const { container } = render(<PendingCreditTopupsBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there are no pending or failed top-ups", () => {
    hookState = {
      topups: [],
      pending: [],
      failed: [],
      isLoading: false,
      isAuthenticated: true,
    };
    const { container } = render(<PendingCreditTopupsBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a single pending notice with the dollar amount", () => {
    const pending = [makeTopup({ id: "p1", amountCents: 1000 })];
    hookState = {
      topups: pending,
      pending,
      failed: [],
      isLoading: false,
      isAuthenticated: true,
    };
    render(<PendingCreditTopupsBanner />);

    const notice = screen.getByTestId("pending-credit-topups-pending");
    expect(notice).toHaveTextContent(/Top-up of \$10 is pending/);
    expect(notice).toHaveTextContent(/1–5 business days/);
  });

  it("aggregates multiple pending top-ups into one notice with a total", () => {
    const pending = [
      makeTopup({ id: "p1", amountCents: 500 }),
      makeTopup({ id: "p2", amountCents: 2500 }),
    ];
    hookState = {
      topups: pending,
      pending,
      failed: [],
      isLoading: false,
      isAuthenticated: true,
    };
    render(<PendingCreditTopupsBanner />);

    const notice = screen.getByTestId("pending-credit-topups-pending");
    expect(notice).toHaveTextContent(/2 top-ups \(\$30 total\) are pending/);
  });

  it("renders a failed notice per failed top-up", () => {
    const failed = [
      makeTopup({ id: "f1", amountCents: 1000, status: "failed" }),
      makeTopup({ id: "f2", amountCents: 2000, status: "failed" }),
    ];
    hookState = {
      topups: failed,
      pending: [],
      failed,
      isLoading: false,
      isAuthenticated: true,
    };
    render(<PendingCreditTopupsBanner />);

    const failedNotices = screen.getAllByTestId("pending-credit-topups-failed");
    expect(failedNotices).toHaveLength(2);
    expect(failedNotices[0]).toHaveTextContent(
      /Top-up of \$10 could not be completed/,
    );
    expect(failedNotices[1]).toHaveTextContent(
      /Top-up of \$20 could not be completed/,
    );
  });

  it("renders both pending and failed notices when both exist", () => {
    const pending = [makeTopup({ id: "p1", amountCents: 1000 })];
    const failed = [
      makeTopup({ id: "f1", amountCents: 500, status: "failed" }),
    ];
    hookState = {
      topups: [...pending, ...failed],
      pending,
      failed,
      isLoading: false,
      isAuthenticated: true,
    };
    render(<PendingCreditTopupsBanner />);

    expect(
      screen.getByTestId("pending-credit-topups-pending"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("pending-credit-topups-failed"),
    ).toBeInTheDocument();
  });

  it("never surfaces the take-rate-derived credited amount", () => {
    // Regression guard mirroring the backend wire-rule: the banner reads
    // only `amountCents`. Even if a future server change accidentally
    // shipped `creditedCents` and the loose-shape normalizer kept it, it
    // must never render here.
    const pending = [makeTopup({ id: "p1", amountCents: 1000 })];
    hookState = {
      topups: pending,
      pending,
      failed: [],
      isLoading: false,
      isAuthenticated: true,
    };
    render(<PendingCreditTopupsBanner />);
    const notice = screen.getByTestId("pending-credit-topups-pending");
    // The only dollar value should be $10. No $9.45, $9.50, etc. that could
    // hint at the post-take-rate credited amount.
    const matches = notice.textContent?.match(/\$\d+(\.\d+)?/g) ?? [];
    expect(matches).toEqual(["$10"]);
  });
});
