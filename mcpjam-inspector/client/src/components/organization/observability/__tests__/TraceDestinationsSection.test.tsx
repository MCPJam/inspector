import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TraceDestinationsSection } from "../TraceDestinationsSection";
import type { TraceDestination } from "@/hooks/useOrgTraceDestinations";

const availabilityMock = vi.fn();
const destinationsMock = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectQueries: () => ({
    sortedProjects: [{ _id: "p1", name: "Checkout" }],
  }),
}));

vi.mock("@/hooks/useOrgTraceDestinations", () => ({
  useTraceDestinationsAvailability: () => availabilityMock(),
  useOrgTraceDestinations: () => destinationsMock(),
}));

const writes = {
  createDestination: vi.fn(),
  updateDestination: vi.fn(),
  deleteDestination: vi.fn(),
  setEnabled: vi.fn(),
  pauseDestination: vi.fn(),
  resumeDestination: vi.fn().mockResolvedValue(null),
  sendTestSpan: vi.fn(),
  startBackfill: vi.fn(),
};

function destination(
  overrides: Partial<TraceDestination> = {},
): TraceDestination {
  return {
    id: "d1",
    organizationId: "org1",
    name: "Coralogix (production)",
    enabled: true,
    endpointUrl: "https://ingress.eu2.coralogix.com:443/v1/traces",
    headerNames: ["Authorization"],
    resourceAttributes: { "cx.application.name": "mcpjam" },
    sourceTypes: ["eval"],
    includeContent: false,
    compression: "gzip",
    projectIds: null,
    preset: "coralogix",
    paused: null,
    health: {
      lastAttemptAt: 1,
      lastDeliveryAt: 1,
      lastDeliveryStatus: "success",
      lastDeliveryError: null,
      lastHttpStatus: 200,
      consecutiveFailures: 0,
      retryNotBefore: null,
      pendingCount: 3,
      pendingCountCapped: false,
      deliveredSessionCount: 12,
      deliveredSpanCount: 340,
      deadLetterCount: 0,
    },
    lastTest: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function setDestinations(rows: TraceDestination[] | undefined) {
  destinationsMock.mockReturnValue({
    destinations: rows,
    isLoading: false,
    error: null,
    isSaving: false,
    ...writes,
  });
}

describe("TraceDestinationsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writes.resumeDestination.mockResolvedValue(null);
    availabilityMock.mockReturnValue({ state: "enabled", canEdit: true });
    setDestinations([destination()]);
  });

  it("renders nothing while availability is still unknown", () => {
    // `undefined` is "not asked yet", not "no" — but it is also not yet a
    // reason to render an admin surface.
    availabilityMock.mockReturnValue(undefined);
    const { container } = render(
      <TraceDestinationsSection organizationId="org1" isAdmin />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the server says the org is not covered", () => {
    availabilityMock.mockReturnValue({ state: "disabled", canEdit: true });
    const { container } = render(
      <TraceDestinationsSection organizationId="org1" isAdmin />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("never renders a header value, only its name", () => {
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);
    // The name is fine to show; the value never reaches the client at all,
    // and this asserts the DTO shape has not quietly grown one.
    expect(document.body.textContent).not.toContain("Bearer");
  });

  it("hides every action from a member", () => {
    availabilityMock.mockReturnValue({ state: "enabled", canEdit: false });
    render(<TraceDestinationsSection organizationId="org1" isAdmin={false} />);
    expect(screen.getByText("Coralogix (production)")).toBeTruthy();
    expect(screen.queryByText("New destination")).toBeNull();
    expect(screen.queryByText("Send test span")).toBeNull();
    expect(screen.queryByText("Edit")).toBeNull();
  });

  it("explains a pause in terms of what to do about it", () => {
    setDestinations([
      destination({ paused: { at: 5, reason: "auth_failed" } }),
    ]);
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);
    expect(screen.getByText(/rejected the credentials/i)).toBeTruthy();
    expect(screen.getByText("Resume")).toBeTruthy();
  });

  it("falls back to the raw reason rather than apologising generically", () => {
    setDestinations([
      destination({ paused: { at: 5, reason: "some_new_reason" } }),
    ]);
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);
    expect(screen.getByText("some_new_reason")).toBeTruthy();
  });

  it("offers to backfill the window a pause dropped", async () => {
    // Just under three days, so the round-UP is unambiguously 3. Rounding up
    // is deliberate: a backfill that stops short of the pause leaves exactly
    // the gap the button exists to close.
    const pausedSince = Date.now() - (3 * 86_400_000 - 3_600_000);
    writes.resumeDestination.mockResolvedValue(pausedSince);
    setDestinations([
      destination({ paused: { at: pausedSince, reason: "manual" } }),
    ]);
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);

    fireEvent.click(screen.getByText("Resume"));
    await waitFor(() =>
      expect(screen.getByText("Backfill the paused window")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("Backfill the paused window"));
    expect(writes.startBackfill).toHaveBeenCalledWith("d1", 3);
  });

  it("shows a capped pending count as N+", () => {
    setDestinations([
      destination({
        health: {
          ...destination().health!,
          pendingCount: 100,
          pendingCountCapped: true,
        },
      }),
    ]);
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);
    expect(screen.getByText("100+")).toBeTruthy();
  });

  it("says whether content is redacted", () => {
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);
    expect(screen.getByText("Redacted")).toBeTruthy();

    setDestinations([destination({ includeContent: true })]);
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);
    expect(screen.getAllByText("Content included").length).toBe(1);
  });

  it("warns that a delete cannot retract what was already delivered", async () => {
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);
    fireEvent.click(screen.getByLabelText("Delete Coralogix (production)"));
    await waitFor(() =>
      expect(screen.getByText(/cannot retract them/i)).toBeTruthy(),
    );
  });
});
