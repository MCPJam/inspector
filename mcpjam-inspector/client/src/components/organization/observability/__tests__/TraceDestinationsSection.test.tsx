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

  it("explains a resolved no instead of leaving a blank page", () => {
    // The nav strip advertises this section from the CLIENT flag, which knows
    // nothing about this organization — so a flagged-in admin whose org the
    // server has not covered can click a real tab and land here. Rendering
    // nothing would read as a broken screen.
    availabilityMock.mockReturnValue({ state: "disabled", canEdit: true });
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);
    expect(screen.getByText(/not enabled for this organization/i)).toBeTruthy();
    expect(screen.queryByText("New destination")).toBeNull();
  });

  it("says plainly when the caller is not a member", () => {
    availabilityMock.mockReturnValue({ state: "unavailable", canEdit: false });
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);
    expect(screen.getByText(/not a member of this organization/i)).toBeTruthy();
  });

  it("never renders a header value, only its name", () => {
    // The fixture is deliberately given a value the DTO has no field for, cast
    // in. If a `headers` field ever reaches the client and something renders
    // it, this catches that; asserting on a fixture that could not hold a
    // value in the first place would have passed forever while checking
    // nothing.
    setDestinations([
      {
        ...destination(),
        headers: { Authorization: "Bearer sk-live-do-not-render" },
      } as unknown as TraceDestination,
    ]);
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);

    expect(screen.getByText("Coralogix (production)")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Bearer");
    expect(document.body.textContent).not.toContain("sk-live-do-not-render");
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
      expect(screen.getByText("Backfill the last 3 days")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("Backfill the last 3 days"));
    expect(writes.startBackfill).toHaveBeenCalledWith("d1", 3);
  });

  it("names the number of days it will actually backfill", async () => {
    // The button used to promise "the paused window", which a whole-day
    // granularity cannot deliver. Saying the real number is the honest
    // version of the same affordance.
    const pausedSince = Date.now() - (3 * 86_400_000 - 3_600_000);
    writes.resumeDestination.mockResolvedValue(pausedSince);
    setDestinations([
      destination({ paused: { at: pausedSince, reason: "manual" } }),
    ]);
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);

    fireEvent.click(screen.getByText("Resume"));
    await waitFor(() =>
      expect(screen.getByText("Backfill the last 3 days")).toBeTruthy(),
    );
    expect(screen.queryByText(/longer than 30 days/i)).toBeNull();
  });

  it("says so when the pause outran what a backfill can reach", async () => {
    const pausedSince = Date.now() - 45 * 86_400_000;
    writes.resumeDestination.mockResolvedValue(pausedSince);
    setDestinations([
      destination({ paused: { at: pausedSince, reason: "manual" } }),
    ]);
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);

    fireEvent.click(screen.getByText("Resume"));
    await waitFor(() =>
      expect(screen.getByText("Backfill the last 30 days")).toBeTruthy(),
    );
    // Silently capping would tell someone their gap was filled when 15 days
    // of it were not.
    expect(screen.getByText(/longer than 30 days/i)).toBeTruthy();

    fireEvent.click(screen.getByText("Backfill the last 30 days"));
    expect(writes.startBackfill).toHaveBeenCalledWith("d1", 30);
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
    const first = render(
      <TraceDestinationsSection organizationId="org1" isAdmin />,
    );
    expect(screen.getByText("Redacted")).toBeTruthy();
    expect(screen.queryByText("Content included")).toBeNull();

    // UNMOUNT between the two. `render` appends a second container rather than
    // replacing the first, so without this the earlier "Redacted" badge stays
    // in the document and a component that rendered BOTH states would still
    // satisfy the assertions below.
    first.unmount();

    setDestinations([destination({ includeContent: true })]);
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);
    expect(screen.getByText("Content included")).toBeTruthy();
    expect(screen.queryByText("Redacted")).toBeNull();
  });

  it("warns that a delete cannot retract what was already delivered", async () => {
    render(<TraceDestinationsSection organizationId="org1" isAdmin />);
    fireEvent.click(screen.getByLabelText("Delete Coralogix (production)"));
    await waitFor(() =>
      expect(screen.getByText(/cannot retract them/i)).toBeTruthy(),
    );
  });
});
