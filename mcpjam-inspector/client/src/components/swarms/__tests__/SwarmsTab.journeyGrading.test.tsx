/**
 * Post-create grading edits on a journey card.
 *
 * Before this affordance a rubric was write-once — authored on the create form
 * or never. The invariants worth pinning are the ones that silently lose data:
 * the editor seeds from the journey's CURRENT rubric, and clearing everything
 * sends `null` (clear) rather than `[]`, which the backend would persist as
 * "graded against nothing".
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Predicate } from "@/shared/eval-matching";

const EXISTING: Predicate = {
  type: "toolCalledAtLeastOnce",
  toolName: "search",
};

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

const persona = {
  _id: "persona-1",
  personaId: "p1",
  name: "Persona One",
  role: "tester",
  notes: "",
};

let journeyRubric: Array<{ id: string; predicate: Predicate }> | null = [
  { id: "crit-existing", predicate: EXISTING },
];

const { updateJourneyMutation } = vi.hoisted(() => ({
  updateJourneyMutation: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return [persona];
      case "journeys:listJourneysByPersona":
        return [
          {
            _id: "journey-1",
            personaRefId: "persona-1",
            goal: "Do the thing",
            hostIds: ["host-1"],
            config: { sessionsPerTarget: 1, maxTurns: 6 },
            rubric: journeyRubric,
          },
        ];
      case "hosts:listHosts":
        return [{ hostId: "host-1", name: "Host One" }];
      case "projectEnvironments:listEnvironments":
        return [];
      default:
        return undefined;
    }
  },
  useMutation: (name: string) => {
    if (name === "journeys:updateJourney") return updateJourneyMutation;
    return vi.fn().mockResolvedValue(undefined);
  },
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  }),
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
  }),
  useProjectServers: () => ({ servers: [], isLoading: false }),
  useDbUserReady: () => true,
}));

vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));
vi.mock("@/lib/scenario-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));
vi.mock("@/components/swarms/SwarmsSessionsPanel", () => ({
  SwarmsSessionsPanel: () => null,
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Stubbed to a pair of buttons: the real editor's id-preservation has its own
// tests, and driving its selects here would test ChecksSection.
vi.mock("@/components/swarms/journey-rubric-editor", () => ({
  JourneyRubricEditor: ({
    value,
    onChange,
  }: {
    value: Array<{ id: string; predicate: Predicate }>;
    onChange: (next: Array<{ id: string; predicate: Predicate }>) => void;
  }) => (
    <div>
      <span data-testid="seeded-criteria">
        {value.map((e) => e.id).join(",")}
      </span>
      <button type="button" onClick={() => onChange([])}>
        clear criteria
      </button>
    </div>
  ),
}));

import { SwarmsTab } from "../SwarmsTab";
import { openPersonasTab } from "./swarms-tab-test-helpers";

beforeEach(() => {
  vi.clearAllMocks();
  journeyRubric = [{ id: "crit-existing", predicate: EXISTING }];
  updateJourneyMutation.mockResolvedValue(undefined);
});

function openGradingEditor() {
  render(<SwarmsTab projectId="proj-1" isAuthenticated />);
  openPersonasTab();
  fireEvent.click(screen.getAllByText("Persona One")[0]);
  fireEvent.click(screen.getByTestId("journey-grading-trigger"));
}

describe("SwarmsTab — journey grading editor", () => {
  it("labels the trigger with the journey's current check count", () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    fireEvent.click(screen.getAllByText("Persona One")[0]);

    expect(screen.getByTestId("journey-grading-trigger")).toHaveTextContent(
      "1 check"
    );
  });

  it("seeds the editor from the journey's existing rubric", async () => {
    openGradingEditor();

    expect(await screen.findByTestId("seeded-criteria")).toHaveTextContent(
      "crit-existing"
    );
  });

  it("sends null — not [] — when the author removes every criterion", async () => {
    openGradingEditor();
    await screen.findByTestId("seeded-criteria");

    fireEvent.click(screen.getByRole("button", { name: /clear criteria/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateJourneyMutation).toHaveBeenCalled());
    expect(updateJourneyMutation.mock.calls[0][0]).toMatchObject({
      journeyRefId: "journey-1",
      rubric: null,
      judgeConfig: null,
    });
  });

  it("reads 'Grading' when the journey has no rubric yet", () => {
    journeyRubric = null;
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    fireEvent.click(screen.getAllByText("Persona One")[0]);

    expect(screen.getByTestId("journey-grading-trigger")).toHaveTextContent(
      "Grading"
    );
  });
});
