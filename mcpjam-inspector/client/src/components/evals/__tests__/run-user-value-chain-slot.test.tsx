/**
 * The run detail's chain slot: which of the two readings gets drawn (UVH-IN6).
 *
 * The claim under test is EXCLUSIVITY. Two readings of the same six stages
 * exist — the legacy rollup's precomputed pass rate and the canonical
 * document's three rates, named exclusions and slices — and they disagree by
 * construction, because their denominators differ. Both on screen at once is
 * worse than either alone: a reader cannot tell which is the report card.
 *
 * The second claim is that falling BACK is not silent when it is a failure and
 * not alarming when it is not. `absent` and the dark-ship window are expected
 * states; `requestFailed` and `invalidContract` are not, and swapping quietly
 * to older numbers would hide them.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  GOLDEN_STAGE_ANALYTICS,
  stageAnalyticsVariation,
} from "@/test/stage-analytics-fixtures";
import { EvalStageAnalyticsError } from "@/lib/apis/eval-stage-analytics-api";

const { fetchMock, flagMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  flagMock: vi.fn(),
}));

vi.mock("@/lib/apis/eval-stage-analytics-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/apis/eval-stage-analytics-api")
  >("@/lib/apis/eval-stage-analytics-api");
  return { ...actual, fetchEvalRunStageAnalytics: fetchMock };
});
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: flagMock }));

const {
  RunUserValueChainSlot,
  useRunUserValueChainChoice,
  RUN_STAGE_ANALYTICS_FLAG,
} = await import("../run-user-value-chain-slot");

const RUN_ID = GOLDEN_STAGE_ANALYTICS.runId;
const LEGACY_TEXT = "the legacy rollup";

function Slot({ runId = RUN_ID }: { runId?: string }) {
  const chain = useRunUserValueChainChoice({ projectId: "p1", runId });
  return (
    <RunUserValueChainSlot
      chain={chain}
      legacy={<div data-testid="legacy">{LEGACY_TEXT}</div>}
    />
  );
}

function rejectWith(kind: Parameters<typeof EvalStageAnalyticsError>[0]) {
  fetchMock.mockRejectedValue(new EvalStageAnalyticsError(kind as never, "no"));
}

beforeEach(() => {
  fetchMock.mockReset();
  flagMock.mockReset();
  flagMock.mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the flag gate", () => {
  it("renders the legacy rollup untouched when the flag is off", async () => {
    // Today's page, exactly. Nothing was attempted, so there is nothing to
    // label it against.
    flagMock.mockReturnValue(false);
    render(<Slot />);

    expect(screen.getByTestId("legacy")).toBeTruthy();
    expect(screen.queryByTestId("run-stage-analytics-legacy-label")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an UNRESOLVED flag as off", async () => {
    // PostHog answers `undefined` while it is still loading. Reading that as
    // on would fire a request per run for every user on every page load.
    flagMock.mockReturnValue(undefined);
    render(<Slot />);

    expect(screen.getByTestId("legacy")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for the flag by its published name", () => {
    // The operator enables this by name; a typo here is a feature that can
    // never be turned on.
    flagMock.mockReturnValue(false);
    render(<Slot />);
    expect(flagMock).toHaveBeenCalledWith(RUN_STAGE_ANALYTICS_FLAG);
  });
});

describe("exactly one reading, never both", () => {
  it("renders the canonical document and NOT the legacy rollup", async () => {
    fetchMock.mockResolvedValue(GOLDEN_STAGE_ANALYTICS);
    render(<Slot />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("run-stage-analytics-canonical"),
      ).toBeTruthy(),
    );
    // The whole point. Two funnels for one run, with different denominators,
    // is worse than either alone.
    expect(screen.queryByTestId("legacy")).toBeNull();
  });

  it("renders the legacy rollup and NOT a canonical document when there is none", async () => {
    rejectWith("notFound");
    render(<Slot />);

    await waitFor(() => expect(screen.queryByTestId("legacy")).toBeTruthy());
    expect(screen.queryByTestId("run-stage-analytics-canonical")).toBeNull();
  });

  it("draws nothing at all while the canonical read is in flight", async () => {
    // Legacy-then-canonical would flash one set of numbers for a run and
    // replace it with different ones.
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { container } = render(<Slot />);
    expect(container.textContent).toBe("");
  });
});

describe("falling back says which it is", () => {
  it("labels the legacy rollup once the canonical read was attempted", async () => {
    rejectWith("notFound");
    render(<Slot />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("run-stage-analytics-legacy-label"),
      ).toBeTruthy(),
    );
    // No service note: this run simply has no canonical document, which is
    // the expected state for anything that finished before the materializer.
    expect(screen.queryByTestId("run-stage-analytics-service-note")).toBeNull();
  });

  it("stays silent about the dark-ship window", async () => {
    // The flag is on before the route is deployed. Expected, not a
    // malfunction, and a red banner would be reporting our own rollout.
    rejectWith("routeUnavailable");
    render(<Slot />);

    await waitFor(() => expect(screen.queryByTestId("legacy")).toBeTruthy());
    expect(screen.queryByTestId("run-stage-analytics-service-note")).toBeNull();
  });

  it.each([["requestFailed"], ["invalidContract"]])(
    "says so out loud when the canonical read really failed (%s)",
    async (kind) => {
      // Swapping silently to the older numbers would hide a real failure
      // behind a funnel that looks fine.
      rejectWith(kind as never);
      render(<Slot />);

      await waitFor(() =>
        expect(
          screen.queryByTestId("run-stage-analytics-service-note"),
        ).toBeTruthy(),
      );
      expect(screen.getByTestId("legacy")).toBeTruthy();
    },
  );

  it("distinguishes a contract failure from a service one", async () => {
    // `invalidContract` is a bug report and `requestFailed` is a service
    // state; one message for both would lose the only one anybody can act on.
    rejectWith("invalidContract");
    const { unmount } = render(<Slot />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("run-stage-analytics-service-note"),
      ).toBeTruthy(),
    );
    const contract = screen.getByTestId(
      "run-stage-analytics-service-note",
    ).textContent;
    unmount();

    rejectWith("requestFailed");
    render(<Slot />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("run-stage-analytics-service-note"),
      ).toBeTruthy(),
    );
    expect(
      screen.getByTestId("run-stage-analytics-service-note").textContent,
    ).not.toBe(contract);
  });
});

describe("the choice the caller reads for its own emptiness check", () => {
  it("reports canonical, legacy and nothing as three different answers", async () => {
    const seen: string[] = [];
    function Probe({ runId }: { runId: string }) {
      seen.push(useRunUserValueChainChoice({ projectId: "p1", runId }).choice);
      return null;
    }

    // In flight → nothing.
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const inflight = render(<Probe runId={RUN_ID} />);
    expect(seen[seen.length - 1]).toBe("nothing");
    inflight.unmount();

    // Answered → canonical.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(stageAnalyticsVariation({ runId: RUN_ID }));
    const ready = render(<Probe runId={RUN_ID} />);
    await waitFor(() => expect(seen[seen.length - 1]).toBe("canonical"));
    ready.unmount();

    // No document → legacy.
    fetchMock.mockReset();
    rejectWith("notFound");
    render(<Probe runId={RUN_ID} />);
    await waitFor(() => expect(seen[seen.length - 1]).toBe("legacy"));
  });

  it("reports a service note the caller can count as content", async () => {
    // A canonical read that really failed on a run with no legacy rollup and
    // no other insight card would otherwise close the rail over the note
    // written specifically to report that failure — the one case where the
    // message is the only thing there is to say. The caller gates on this, so
    // the note has to be readable from the hook's result rather than only
    // rendered inside the slot.
    rejectWith("requestFailed");
    let chain: { serviceNote: string | null; choice: string } | undefined;
    function Probe() {
      chain = useRunUserValueChainChoice({ projectId: "p1", runId: RUN_ID });
      return null;
    }
    render(<Probe />);
    await waitFor(() => expect(chain!.serviceNote).not.toBeNull());
    expect(chain!.choice).toBe("legacy");
  });

  it("reports no service note for the states that are not failures", async () => {
    // `absent` and the dark-ship window must stay silent, or every run that
    // finished before the materializer shipped would hold a rail open on a
    // message about nothing being wrong.
    for (const kind of ["notFound", "routeUnavailable"] as const) {
      fetchMock.mockReset();
      rejectWith(kind);
      let note: string | null | undefined;
      function Probe() {
        note = useRunUserValueChainChoice({
          projectId: "p1",
          runId: RUN_ID,
        }).serviceNote;
        return null;
      }
      const { unmount } = render(<Probe />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(note).toBeNull();
      unmount();
    }
  });

  it("reports legacy immediately when the flag is off, never nothing", async () => {
    // A run detail whose rail waits on this must not blank the chain for
    // every user who does not have the flag.
    flagMock.mockReturnValue(false);
    let choice = "";
    function Probe() {
      choice = useRunUserValueChainChoice({
        projectId: "p1",
        runId: RUN_ID,
      }).choice;
      return null;
    }
    render(<Probe />);
    expect(choice).toBe("legacy");
  });
});
