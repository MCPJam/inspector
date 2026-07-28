/**
 * AI generation dialogs: gating on server group + clients, row creation
 * through the ordinary mutations, partial-journey-failure copy, and inline
 * quota (429) rendering.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

const persona = {
  _id: "persona-1",
  personaId: "p1",
  name: "Persona One",
  role: "tester",
  notes: "cares about speed",
};
const host = {
  hostId: "host-1",
  name: "Host One",
  modelId: "openai/gpt-4o-mini",
  ownerScope: { type: "journeys" },
};

/** Mutable so a created persona shows up in the list the sidebar renders —
 * that is how the test observes the new row being SELECTED, not just written. */
let personaList: Array<Record<string, unknown>> = [];

const {
  createPersonaMutation,
  createJourneyMutation,
  generatePersonaMock,
  generateJourneysMock,
  toastMock,
} = vi.hoisted(() => ({
  createPersonaMutation: vi.fn(),
  createJourneyMutation: vi.fn(),
  generatePersonaMock: vi.fn(),
  generateJourneysMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return personaList;
      case "journeys:listJourneysByPersona":
        return [];
      case "hosts:listHosts":
        return [host];
      default:
        return undefined;
    }
  },
  useMutation: (name: string) => {
    if (name === "personas:createPersona") return createPersonaMutation;
    if (name === "journeys:createJourney") return createJourneyMutation;
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
    serverAttachments: [
      {
        _id: "att-1",
        name: "group 1",
        serverIds: ["srv-1"],
        resolvedServerNames: ["alpha"],
      },
    ],
    isLoading: false,
  }),
  useProjectServers: () => ({ servers: [], isLoading: false }),
  useDbUserReady: () => true,
}));

vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (id: string) => void;
  }) => (
    <button
      type="button"
      data-testid="mock-server-group-picker"
      onClick={() => onChange("att-1")}
    >
      {value ? `Selected ${value}` : "No server group · pick one"}
    </button>
  ),
}));

vi.mock("@/lib/swarm-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarm-api")>();
  return {
    ...actual,
    launchJourneyRun: vi.fn(),
    generateSwarmPersona: (...args: unknown[]) => generatePersonaMock(...args),
    generateSwarmJourneys: (...args: unknown[]) =>
      generateJourneysMock(...args),
  };
});

vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));
vi.mock("@/lib/chatbox-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { SwarmsTab } from "../SwarmsTab";
import { SwarmGenerateError } from "@/lib/swarm-api";

beforeEach(() => {
  vi.clearAllMocks();
  personaList = [persona];
  createPersonaMutation.mockImplementation(async (args: any) => {
    const row = { ...args, _id: "persona-new", personaId: "pnew" };
    personaList = [...personaList, row];
    return row;
  });
  createJourneyMutation.mockResolvedValue({ _id: "journey-new" });
});

function openGeneratePersona() {
  render(<SwarmsTab projectId="proj-1" isAuthenticated />);
  fireEvent.click(
    screen.getByRole("button", { name: /generate persona with ai/i })
  );
}

async function pickClient(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name: /attached clients/i }));
  fireEvent.click(await screen.findByRole("checkbox", { name }));
}

describe("SwarmsTab — generate persona", () => {
  it("keeps Generate disabled until a server group and client are picked", async () => {
    openGeneratePersona();
    const submit = screen.getByRole("button", { name: /generate persona/i });
    expect(submit).toBeDisabled();

    await pickClient(/host one/i);
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByTestId("mock-server-group-picker"));
    expect(submit).not.toBeDisabled();
  });

  it("creates the persona as generated, then one journey per result", async () => {
    generatePersonaMock.mockResolvedValue({
      persona: { name: "Curious Newcomer", role: "hobbyist", notes: "n" },
      journeys: [
        { name: "J1", goal: "goal one" },
        { goal: "goal two" },
      ],
    });

    openGeneratePersona();
    await pickClient(/host one/i);
    fireEvent.click(screen.getByTestId("mock-server-group-picker"));
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    await waitFor(() => {
      expect(createPersonaMutation).toHaveBeenCalledTimes(1);
    });
    expect(createPersonaMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        source: "generated",
        name: "Curious Newcomer",
        role: "hobbyist",
        notes: "n",
      })
    );
    // Avatar indices must be in `createPersona`'s accepted range — the
    // mutation throws (not clamps) on out-of-range values.
    const personaArgs = createPersonaMutation.mock.calls[0]![0] as any;
    expect(personaArgs.avatarShape).toBeGreaterThanOrEqual(0);
    expect(personaArgs.avatarShape).toBeLessThanOrEqual(5);
    expect(personaArgs.avatarPalette).toBeGreaterThanOrEqual(0);
    expect(personaArgs.avatarPalette).toBeLessThanOrEqual(5);

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledTimes(2);
    });
    expect(createJourneyMutation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectId: "proj-1",
        personaRefId: "persona-new",
        name: "J1",
        goal: "goal one",
        hostIds: ["host-1"],
        serverAttachmentId: "att-1",
        config: { sessionsPerHost: 1, maxTurns: 6 },
      })
    );
    // The unnamed journey must not send an empty `name`.
    const secondCall = createJourneyMutation.mock.calls[1]![0] as any;
    expect(secondCall.name).toBeUndefined();
    expect(secondCall.goal).toBe("goal two");

    // The generated persona must also be SELECTED — the detail header renders
    // the selected persona's name, so a regression dropping onPersonaCreated
    // would leave "Persona One" selected and fail here.
    await waitFor(() => {
      expect(screen.getAllByText("Curious Newcomer").length).toBeGreaterThan(1);
    });

    // Forwards the dialog's grounding + count to the backend.
    expect(generatePersonaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        serverAttachmentId: "att-1",
        journeyCount: 3,
      })
    );
  });

  it("keeps created rows and reports the shortfall when a journey fails", async () => {
    generatePersonaMock.mockResolvedValue({
      persona: { name: "P", role: "R" },
      journeys: [{ goal: "one" }, { goal: "two" }],
    });
    createJourneyMutation
      .mockResolvedValueOnce({ _id: "journey-1" })
      .mockRejectedValueOnce(new Error("nope"));

    openGeneratePersona();
    await pickClient(/host one/i);
    fireEvent.click(screen.getByTestId("mock-server-group-picker"));
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        "Created persona + 1 of 2 journeys"
      );
    });
  });

  it("reports the mutation error when no journey survives, keeping the persona", async () => {
    generatePersonaMock.mockResolvedValue({
      persona: { name: "P", role: "R" },
      journeys: [{ goal: "one" }, { goal: "two" }],
    });
    createJourneyMutation.mockRejectedValue(
      new Error("Server attachment not found")
    );

    openGeneratePersona();
    await pickClient(/host one/i);
    fireEvent.click(screen.getByTestId("mock-server-group-picker"));
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    // No "0 of 2" success toast — the dialog stays open and says why.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Server attachment not found");
    expect(toastMock.success).not.toHaveBeenCalled();
    // The persona itself did land — it must still be written, not rolled back.
    expect(createPersonaMutation).toHaveBeenCalledTimes(1);

    // ...and generation must now be locked. Re-submitting would spend quota
    // and create a SECOND persona rather than retrying the journey writes.
    const submit = screen.getByRole("button", { name: /generate persona/i });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => {
      expect(createPersonaMutation).toHaveBeenCalledTimes(1);
    });
    expect(generatePersonaMock).toHaveBeenCalledTimes(1);
    // "Cancel" would misdescribe a dialog that already wrote a row, so the
    // footer action is relabelled. (Radix renders its own "Close" X, so assert
    // the absence of "Cancel" rather than the presence of "Close".)
    expect(
      screen.queryByRole("button", { name: /^cancel$/i })
    ).not.toBeInTheDocument();
  });

  it("renders a quota 429 inline instead of closing the dialog", async () => {
    generatePersonaMock.mockRejectedValue(
      new SwarmGenerateError(429, "You've hit your usage limit for today.")
    );

    openGeneratePersona();
    await pickClient(/host one/i);
    fireEvent.click(screen.getByTestId("mock-server-group-picker"));
    fireEvent.click(screen.getByRole("button", { name: /generate persona/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You've hit your usage limit for today.");
    expect(createPersonaMutation).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /generate persona/i })
    ).toBeInTheDocument();
  });
});

describe("SwarmsTab — generate journeys", () => {
  it("generates against the selected persona and creates the rows", async () => {
    generateJourneysMock.mockResolvedValue({
      journeys: [{ name: "JA", goal: "goal a" }],
    });

    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    // SwarmsTab auto-selects the first persona, so the journeys panel (and its
    // Generate button) is already mounted.
    fireEvent.click(
      screen.getByRole("button", { name: /generate journeys with ai/i })
    );

    await pickClient(/host one/i);
    fireEvent.click(screen.getByTestId("mock-server-group-picker"));
    fireEvent.click(screen.getByRole("button", { name: /generate journeys/i }));

    await waitFor(() => {
      expect(generateJourneysMock).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          serverAttachmentId: "att-1",
          journeyCount: 3,
          persona: {
            name: "Persona One",
            role: "tester",
            notes: "cares about speed",
          },
        })
      );
    });

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          personaRefId: "persona-1",
          name: "JA",
          goal: "goal a",
          hostIds: ["host-1"],
          serverAttachmentId: "att-1",
        })
      );
    });
    // Generating journeys must never create a persona.
    expect(createPersonaMutation).not.toHaveBeenCalled();
  });

  it("surfaces the mutation error when every journey write fails", async () => {
    generateJourneysMock.mockResolvedValue({
      journeys: [{ goal: "goal a" }, { goal: "goal b" }],
    });
    createJourneyMutation.mockRejectedValue(new Error("Goal is required"));

    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    // SwarmsTab auto-selects the first persona, so the journeys panel (and its
    // Generate button) is already mounted.
    fireEvent.click(
      screen.getByRole("button", { name: /generate journeys with ai/i })
    );

    await pickClient(/host one/i);
    fireEvent.click(screen.getByTestId("mock-server-group-picker"));
    fireEvent.click(screen.getByRole("button", { name: /generate journeys/i }));

    // Nothing was saved after spending generation quota — say so inline and
    // keep the dialog open, rather than a "Created 0 of 2" success toast.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Goal is required");
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
