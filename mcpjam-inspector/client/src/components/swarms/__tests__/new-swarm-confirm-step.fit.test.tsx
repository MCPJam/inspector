/**
 * The Confirm step's "Run K conversations instead" fit applies only to the
 * plan it priced. Environments and the turn limit arrive as props, so the
 * step is rendered directly and those props change while the fit's own quote
 * is still pending.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const quotePlanMock = vi.fn();
const quoteStateMock = vi.fn();
vi.mock("@/hooks/use-swarm-launch-quote", () => ({
  useSwarmLaunchQuote: () => ({
    state: quoteStateMock(),
    quotePlan: quotePlanMock,
  }),
}));
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useConvex: () => ({ query: vi.fn() }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { NewSwarmConfirmStep } from "../new-swarm-confirm-step";
import { track } from "@/lib/analytics";

type Props = ComponentProps<typeof NewSwarmConfirmStep>;

const quote = (overrides: Record<string, unknown> = {}) => ({
  sessions: 2,
  starterSessions: 0,
  creditSessions: 2,
  creditsRequiredP50: 4,
  creditsRequiredP90: 6,
  admitThreshold: 6,
  creditsAvailable: 3,
  maxAffordableSessions: 1,
  fits: false,
  resetsAt: null,
  ...overrides,
});

function props(overrides: Partial<Props> = {}): Props {
  return {
    proposed: [
      {
        key: "persona-1",
        name: "Refund Chaser",
        role: "Support agent",
        avatarShape: 0,
        avatarPalette: 0,
        journeys: [
          { key: "goal-1", goal: "Refund the charge" },
          { key: "goal-2", goal: "Dispute a refund" },
        ],
      },
    ],
    onProposedChange: vi.fn(),
    reusedPersonas: [],
    onRemoveReused: vi.fn(),
    iterationsByPersona: { "persona-1": 1 },
    onIterationsChange: vi.fn(),
    environmentCount: 1,
    environmentLabels: ["Staging"],
    environmentIds: ["env-1"],
    environmentRowsById: new Map(),
    hostNameById: (hostId) => hostId,
    launching: false,
    errorMessage: null,
    onBack: vi.fn(),
    onLaunch: vi.fn(),
    availablePersonas: [],
    onAddReused: vi.fn(),
    onSaveReusedPersona: vi.fn(async () => {}),
    onSaveReusedGoal: vi.fn(async () => {}),
    projectId: "proj-1",
    maxTurns: 6,
    ...overrides,
  };
}

describe("NewSwarmConfirmStep fit", () => {
  beforeEach(() => {
    vi.mocked(track).mockClear();
    quotePlanMock.mockReset();
    quoteStateMock.mockReset().mockReturnValue({
      status: "ready",
      quote: quote(),
    });
  });

  it("applies a fit whose plan did not change while it was quoted", async () => {
    quotePlanMock.mockResolvedValue(quote({ sessions: 1, fits: true }));
    const initial = props();
    render(<NewSwarmConfirmStep {...initial} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("new-swarm-fit-plan"));
    });

    expect(initial.onProposedChange).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(
      "swarm_create_fit_applied",
      expect.anything(),
    );
  });

  it.each([
    [
      "the environment selection",
      {
        environmentIds: ["env-1", "env-2"],
        environmentCount: 2,
        environmentLabels: ["Staging", "Production"],
      },
    ],
    ["the turn limit", { maxTurns: 9 }],
  ] as const)(
    "drops a fit still being quoted when %s changes",
    async (_label, change) => {
      let resolveFit: (value: unknown) => void = () => {};
      quotePlanMock.mockImplementation(
        () => new Promise((resolve) => (resolveFit = resolve)),
      );
      const initial = props();
      const { rerender } = render(<NewSwarmConfirmStep {...initial} />);

      fireEvent.click(screen.getByTestId("new-swarm-fit-plan"));
      expect(quotePlanMock).toHaveBeenCalledTimes(1);
      rerender(<NewSwarmConfirmStep {...initial} {...change} />);
      await act(async () => {
        resolveFit(quote({ sessions: 1, fits: true }));
      });

      expect(initial.onProposedChange).not.toHaveBeenCalled();
      expect(initial.onIterationsChange).not.toHaveBeenCalled();
      expect(track).not.toHaveBeenCalledWith(
        "swarm_create_fit_applied",
        expect.anything(),
      );
    },
  );
});
