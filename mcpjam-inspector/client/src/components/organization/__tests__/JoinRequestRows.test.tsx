import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import type { DecisionResult } from "@/components/access-requests/access-request-api";
import type { OrganizationAccessRequestRow } from "@/hooks/useWorkOrganizations";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast }));

import {
  askedToJoinWhen,
  joinRequestMatches,
  JoinRequestRows,
} from "../JoinRequestRows";

const NOW = new Date(2026, 10, 20, 15, 0).getTime();
const JO: OrganizationAccessRequestRow = {
  requestId: "req_jo",
  userId: "user_jo",
  name: "Jo Chen",
  email: "jo@acme.com",
  requestedAt: new Date(2026, 10, 20, 9, 30).getTime(),
};
const MORGAN: OrganizationAccessRequestRow = {
  requestId: "req_morgan",
  userId: "user_morgan",
  name: null,
  email: "morgan@acme.com",
  requestedAt: new Date(2026, 10, 19, 22, 0).getTime(),
};

function renderRows(
  overrides: Partial<Parameters<typeof JoinRequestRows>[0]> = {},
) {
  const decide =
    vi.fn<(requestId: string, decision: string) => Promise<DecisionResult>>();
  const view = render(
    <JoinRequestRows
      requests={[JO, MORGAN]}
      organizationName="Acme"
      decide={decide}
      {...overrides}
    />,
  );
  return { decide, ...view };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const button = (name: string) => screen.getByRole("button", { name });

describe("JoinRequestRows", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    toast.success.mockReset();
    toast.info.mockReset();
    toast.error.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("shows each requester with the Requested pill and when they asked", () => {
    renderRows();
    expect(screen.getByText("Jo Chen")).toBeInTheDocument();
    expect(
      screen.getByText("jo@acme.com · Asked to join today"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Requested")).toHaveLength(2);
    // No name: the email stands in.
    expect(screen.getByText("morgan@acme.com")).toBeInTheDocument();
    expect(
      screen.getByText("morgan@acme.com · Asked to join yesterday"),
    ).toBeInTheDocument();
    expect(button("Approve Jo Chen")).toHaveTextContent("Approve");
    expect(button("Decline Jo Chen")).toHaveTextContent("Decline");
    expect(button("Approve morgan@acme.com")).toBeEnabled();
  });

  it("counts older requests in calendar days", () => {
    expect(askedToJoinWhen(new Date(2026, 10, 17, 23, 59).getTime(), NOW)).toBe(
      "Asked to join 3 days ago",
    );
    expect(askedToJoinWhen(new Date(2026, 10, 19, 0, 1).getTime(), NOW)).toBe(
      "Asked to join yesterday",
    );
    expect(askedToJoinWhen(new Date(2026, 10, 20, 0, 0).getTime(), NOW)).toBe(
      "Asked to join today",
    );
  });

  it("saves one row's decision while the others stay usable", async () => {
    const { decide } = renderRows();
    const pending = deferred<DecisionResult>();
    decide.mockReturnValue(pending.promise);

    fireEvent.click(button("Approve Jo Chen"));
    expect(decide).toHaveBeenCalledWith("req_jo", "approve");
    expect(button("Approve Jo Chen")).toHaveTextContent("Saving…");
    expect(button("Approve Jo Chen")).toBeDisabled();
    expect(button("Decline Jo Chen")).toBeDisabled();
    expect(button("Decline Jo Chen")).toHaveTextContent("Decline");
    expect(button("Approve morgan@acme.com")).toBeEnabled();

    await act(async () =>
      pending.resolve({ status: "approved", access: "granted" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Request approved", {
      description: "Jo Chen is now a member of Acme.",
    });
    expect(button("Approve Jo Chen")).toHaveTextContent("Approve");
  });

  it.each([
    [
      "declined",
      "decline",
      { status: "declined", access: "pending" },
      "success",
      "Request declined",
      "Jo Chen was not added to Acme.",
    ],
    [
      "waiting on a seat payment",
      "approve",
      { status: "approved", access: "pending", seatPaymentIntentId: "seat_1" },
      "info",
      "Approved, waiting on a seat payment",
      "An organization owner has to finish the seat payment in organization billing. Jo Chen joins Acme after that.",
    ],
    [
      "waiting on the invitation",
      "approve",
      { status: "approved", access: "pending", seatPaymentIntentId: null },
      "info",
      "Approved, waiting on the invitation",
      "Jo Chen joins Acme once they accept the invitation.",
    ],
  ] as const)(
    "toasts the %s result",
    async (_case, decision, result, kind, title, description) => {
      const { decide } = renderRows();
      decide.mockResolvedValue(result);
      const label = decision === "approve" ? "Approve" : "Decline";
      await act(async () => fireEvent.click(button(`${label} Jo Chen`)));
      expect(decide).toHaveBeenCalledWith("req_jo", decision);
      expect(toast[kind]).toHaveBeenCalledWith(title, { description });
    },
  );

  it.each([
    [
      "SEAT_PAYMENT_OWNER_REQUIRED",
      "An organization owner has to approve this",
      "Approving adds a paid seat. Ask an organization owner to approve this request, or to add the seat in organization billing.",
    ],
    [
      "SEAT_PAYMENT_IN_PROGRESS",
      "Another seat payment is open",
      "Finish or cancel the open seat payment in organization billing, then approve this request.",
    ],
  ])("toasts the %s refusal", async (code, title, description) => {
    const { decide } = renderRows();
    decide.mockRejectedValue(new ConvexError({ code, message: "x" }));
    await act(async () => fireEvent.click(button("Approve Jo Chen")));
    expect(toast.error).toHaveBeenCalledWith(title, { description });
    expect(button("Approve Jo Chen")).toBeEnabled();
  });

  it("toasts any other failure", async () => {
    const { decide } = renderRows();
    decide.mockRejectedValue({});
    await act(async () => fireEvent.click(button("Decline Jo Chen")));
    expect(toast.error).toHaveBeenCalledWith(
      "Could not save your decision. Try again.",
    );
    expect(button("Decline Jo Chen")).toBeEnabled();
  });

  it("follows the member search and shows only under All roles", () => {
    expect(joinRequestMatches(JO, "CHEN", "all")).toBe(true);
    expect(joinRequestMatches(MORGAN, "CHEN", "all")).toBe(false);
    expect(joinRequestMatches(MORGAN, "morgan@", "all")).toBe(true);
    expect(joinRequestMatches(JO, "", "member")).toBe(false);
  });

  it("renders nothing without requests", () => {
    const { container } = renderRows({ requests: [] });
    expect(container).toBeEmptyDOMElement();
  });
});
