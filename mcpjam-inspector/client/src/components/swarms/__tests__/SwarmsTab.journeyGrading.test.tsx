import { ConvexError } from "convex/values";
import { toast } from "@/lib/toast";
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

let viewerId = "creator";
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
      case "users:getCurrentUser":
        return { _id: viewerId };
      case "projects:getMyProjects":
        return [{ _id: "proj-1", organizationId: "org-1" }];
      case "billing:getOrganizationBillingStatus":
        return { effectivePlan: "free" };
      case "personas:listPersonas":
        return [persona];
      case "journeys:listJourneysByPersona":
        return [
          {
            _id: "journey-1",
            createdByUserId: "creator",
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
  viewerId = "creator";
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
  it("offers Team instead of editing another creator's settings on Free", () => {
    viewerId = "collaborator";
    openGradingEditor();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "requires Team or Enterprise",
    );
    expect(
      screen.getByRole("link", { name: "View Team plans" }),
    ).toHaveAttribute("href", "/organizations/org-1/plans");
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(updateJourneyMutation).not.toHaveBeenCalled();
  });

  it("toasts a collaborative editing denial from a journey save", async () => {
    updateJourneyMutation.mockRejectedValueOnce(
      new ConvexError({ code: "COLLABORATIVE_EDITING_REQUIRED" }),
    );
    openGradingEditor();
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Editing another member's work requires Team or Enterprise.",
      ),
    );
    expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("labels the trigger with the journey's current check count", () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    fireEvent.click(screen.getAllByText("Persona One")[0]);

    expect(screen.getByTestId("journey-grading-trigger")).toHaveTextContent(
      "1 evaluator",
    );
  });

  it("seeds the editor from the journey's existing rubric", async () => {
    openGradingEditor();

    expect(await screen.findByTestId("seeded-criteria")).toHaveTextContent(
      "crit-existing",
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
      "Grading",
    );
  });
});
