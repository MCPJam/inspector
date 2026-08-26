/**
 * Personas create/edit UX on SwarmsTab — dialog create + blur-save profile notes.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// NewJourneyButton's Advanced → Judge section pulls the model catalog via
// useAvailableModels (AppStateProvider-coupled); these tests render SwarmsTab
// without providers, so stub it to an empty catalog.
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

const persona = {
  _id: "persona-1",
  personaId: "p1",
  name: "Persona One",
  role: "tester",
  notes: "curious and impatient",
};

const {
  createPersonaMutation,
  updatePersonaMutation,
  deletePersonaMutation,
  runningPersonaRefIds,
  personaRows,
  journeyRows,
} = vi.hoisted(() => ({
  createPersonaMutation: vi.fn(),
  updatePersonaMutation: vi.fn(),
  deletePersonaMutation: vi.fn(),
  runningPersonaRefIds: { current: [] as string[] },
  personaRows: {
    current: [] as {
      _id: string;
      personaId: string;
      name: string;
      role: string;
      notes: string;
    }[],
  },
  journeyRows: { current: [] as Record<string, unknown>[] },
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return personaRows.current;
      case "journeys:listJourneysByPersona":
        return journeyRows.current;
      case "hosts:listHosts":
        return [];
      case "journeyRuns:listRunningPersonaRefIds":
        return runningPersonaRefIds.current;
      default:
        return undefined;
    }
  },
  useMutation: (name: string) => {
    if (name === "personas:createPersona") return createPersonaMutation;
    if (name === "personas:updatePersona") return updatePersonaMutation;
    if (name === "personas:deletePersona") return deletePersonaMutation;
    return vi.fn().mockResolvedValue(undefined);
  },
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock("@/lib/swarm-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarm-api")>();
  return {
    ...actual,
    launchJourneyRun: vi.fn(),
  };
});

vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));
vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: () => null,
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
  }),
  useProjectServers: () => ({ servers: [], isLoading: false }),
  useDbUserReady: () => true,
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

import { SwarmsTab } from "../SwarmsTab";
import { openPersonasTab } from "./swarms-tab-test-helpers";

function renderPersonasTab() {
  render(<SwarmsTab projectId="proj-1" isAuthenticated />);
  openPersonasTab();
}

beforeEach(() => {
  vi.clearAllMocks();
  runningPersonaRefIds.current = [];
  personaRows.current = [persona];
  journeyRows.current = [];
  createPersonaMutation.mockResolvedValue({ _id: "persona-new" });
  updatePersonaMutation.mockResolvedValue({ ...persona });
  deletePersonaMutation.mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("SwarmsTab — persona create/edit", () => {
  it("preselects the first persona on the Personas tab", async () => {
    renderPersonasTab();

    await waitFor(() => {
      expect(screen.getByLabelText("Use cases and context")).toBeTruthy();
    });
    expect(
      (screen.getByLabelText("Use cases and context") as HTMLTextAreaElement).value
    ).toBe("curious and impatient");
    expect(
      screen.queryByText("Select a persona to see its goals.")
    ).toBeNull();
  });

  it("creates a persona row immediately instead of opening a modal", async () => {
    createPersonaMutation.mockResolvedValue({
      _id: "persona-new",
      name: "New persona",
      role: "Role",
      notes: "",
    });

    renderPersonasTab();

    const aside = screen.getByRole("complementary");
    fireEvent.click(within(aside).getByRole("button", { name: /^new$/i }));

    await waitFor(() => {
      expect(createPersonaMutation).toHaveBeenCalledWith({
        projectId: "proj-1",
        name: "New persona",
        role: "Role",
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("saves personality notes on blur via updatePersona", async () => {
    renderPersonasTab();

    const notes = await screen.findByLabelText("Use cases and context");
    expect((notes as HTMLTextAreaElement).value).toBe("curious and impatient");

    fireEvent.change(notes, { target: { value: "calm and thorough" } });
    fireEvent.blur(notes);

    await waitFor(() => {
      expect(updatePersonaMutation).toHaveBeenCalledWith({
        personaRefId: "persona-1",
        notes: "calm and thorough",
      });
    });
  });

  it("saves an inline name edit via updatePersona", async () => {
    renderPersonasTab();

    const nameLabels = await screen.findAllByText("Persona One");
    fireEvent.click(nameLabels[nameLabels.length - 1]!);
    const input = screen.getByDisplayValue("Persona One");
    fireEvent.change(input, { target: { value: "Persona Two" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(updatePersonaMutation).toHaveBeenCalledWith({
        personaRefId: "persona-1",
        name: "Persona Two",
      });
    });
  });

  it("deletes a persona from the sidebar trash button", async () => {
    renderPersonasTab();

    const aside = await screen.findByRole("complementary");
    fireEvent.click(
      within(aside).getByRole("button", { name: "Delete Persona One" })
    );

    await waitFor(() => {
      expect(deletePersonaMutation).toHaveBeenCalledWith({
        personaRefId: "persona-1",
      });
    });
  });

  it("saves avatar look changes from the picker via updatePersona", async () => {
    const { resolvePersonaPixelLook } = await import(
      "../persona-pixel-avatar"
    );
    const seeded = resolvePersonaPixelLook("persona-1");

    renderPersonasTab();
    fireEvent.click(await screen.findByTestId("persona-avatar-look-trigger"));
    fireEvent.click(screen.getByTestId("persona-avatar-next-shape"));

    await waitFor(() => {
      expect(updatePersonaMutation).toHaveBeenCalledWith({
        personaRefId: "persona-1",
        avatarShape: (seeded.shapeIndex + 1) % 6,
        avatarPalette: seeded.paletteIndex,
      });
    });
  });

  it("lights the sidebar avatar when the persona has a running journey", async () => {
    runningPersonaRefIds.current = ["persona-1"];
    renderPersonasTab();

    await waitFor(() => {
      const aside = screen.getByRole("complementary");
      const avatar = within(aside).getByTestId("persona-pixel-avatar");
      expect(avatar.getAttribute("data-state")).toBe("running");
      // Peppy bob is for running journeys — not merely being selected.
      expect(avatar.getAttribute("data-busy")).toBe("true");
    });
  });

  it("does not mark a selected idle persona as busy", async () => {
    runningPersonaRefIds.current = [];
    renderPersonasTab();

    await waitFor(() => {
      const aside = screen.getByRole("complementary");
      const avatar = within(aside).getByTestId("persona-pixel-avatar");
      expect(avatar.getAttribute("data-state")).toBe("idle");
      expect(avatar.getAttribute("data-busy")).toBe("false");
    });
  });
});

/**
 * BB-123: the library mirrors Confirm personas — same field groups, same sense
 * of what a persona is — and edits commit directly, with no Save button.
 */
describe("SwarmsTab — Personas library mirrors Confirm personas", () => {
  it("groups the fields the way Confirm does", async () => {
    renderPersonasTab();
    await screen.findByLabelText("Use cases and context");

    expect(screen.getByText("Persona")).toBeVisible();
    expect(screen.getByText(/use cases & context/i)).toBeVisible();
    expect(screen.getByText("Goals")).toBeVisible();
    // Direct fields, not click-to-reveal editors.
    expect(screen.getByLabelText("Name")).toHaveValue("Persona One");
    expect(screen.getByLabelText("Role")).toHaveValue("tester");
  });

  it("has no Save button — Delete persona is the only action", async () => {
    renderPersonasTab();
    await screen.findByLabelText("Use cases and context");

    expect(
      screen.queryByRole("button", { name: /^save( changes)?$/i })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^delete persona$/i })
    ).toBeVisible();
  });

  it("commits the role on blur, and sends only that field", async () => {
    renderPersonasTab();
    const role = await screen.findByLabelText("Role");

    fireEvent.change(role, { target: { value: "finance ops" } });
    fireEvent.blur(role);

    await waitFor(() => {
      expect(updatePersonaMutation).toHaveBeenCalledWith({
        personaRefId: "persona-1",
        role: "finance ops",
      });
    });
  });

  it("rolls an emptied name back instead of saving a nameless persona", async () => {
    renderPersonasTab();
    const name = await screen.findByLabelText("Name");

    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.blur(name);

    expect(name).toHaveValue("Persona One");
    expect(updatePersonaMutation).not.toHaveBeenCalled();
  });

  it("renders each goal as a bullet, its text, and a delete control", async () => {
    // A journey is mocked on purpose. The first version of this ran against the
    // EMPTY goals state, so it asserted against a row that was never rendered —
    // a test that could not fail.
    journeyRows.current = [
      {
        _id: "journey-1",
        journeyId: "j1",
        personaRefId: "persona-1",
        name: "Reconcile payouts",
        goal: "Reconcile the payouts ledger",
        hostIds: [],
        environmentIds: [],
        config: { sessionsPerTarget: 1, maxTurns: 6 },
      },
    ];
    renderPersonasTab();

    // The row is really on screen before anything is asserted about it. The
    // list renders `journey.goal`, not the journey name.
    expect(
      await screen.findByText("Reconcile the payouts ledger")
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Delete goal Reconcile the payouts ledger",
      })
    ).toBeVisible();
    // The library row is the whole goal: no per-goal run, history or grading
    // affordances travel with it.
    expect(
      screen.queryByRole("button", { name: "Run" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("journey-grading-trigger")
    ).not.toBeInTheDocument();
  });
});

describe("SwarmsTab — Personas library search", () => {
  const many = Array.from({ length: 7 }, (_, index) => ({
    _id: `persona-${index + 1}`,
    personaId: `p${index + 1}`,
    name: index === 0 ? "Persona One" : `Persona ${index + 1}`,
    role: index === 3 ? "finance ops" : "tester",
    notes: "",
  }));

  it("stays hidden while the library is short enough to scan", async () => {
    renderPersonasTab();
    await screen.findByLabelText("Use cases and context");

    expect(screen.queryByTestId("swarm-persona-search")).not.toBeInTheDocument();
  });

  it("filters the rail by name and by role once the library grows", async () => {
    personaRows.current = many;
    renderPersonasTab();

    const search = await screen.findByTestId("swarm-persona-search");
    const aside = screen.getByRole("complementary");

    fireEvent.change(search, { target: { value: "finance" } });
    expect(within(aside).getByText("Persona 4")).toBeVisible();
    expect(within(aside).queryByText("Persona 2")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "Persona 2" } });
    expect(within(aside).getByText("Persona 2")).toBeVisible();
    expect(within(aside).queryByText("Persona 4")).not.toBeInTheDocument();
  });

  it("says so when nothing matches, rather than showing an empty rail", async () => {
    personaRows.current = many;
    renderPersonasTab();

    fireEvent.change(await screen.findByTestId("swarm-persona-search"), {
      target: { value: "zzz" },
    });

    expect(screen.getByTestId("swarm-persona-search-empty")).toHaveTextContent(
      /no personas match/i
    );
  });

  it("stays available when the list shrinks under the threshold mid-search", async () => {
    // Deleting a persona can take a 7-row library under the threshold while a
    // query is still applied. Hiding the input then would leave the rail
    // filtered with no control to clear it.
    personaRows.current = many;
    renderPersonasTab();

    const search = await screen.findByTestId("swarm-persona-search");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByTestId("swarm-persona-search-empty")).toBeVisible();

    // Shrink the library WITHOUT remounting — a remount would reset the query
    // and the regression would go unobserved. The second change re-renders
    // against the shorter list with the filter still on.
    personaRows.current = many.slice(0, 3);
    fireEvent.change(search, { target: { value: "zzzz" } });

    expect(screen.getByTestId("swarm-persona-search")).toBeVisible();
    expect(screen.getByTestId("swarm-persona-search-empty")).toBeVisible();

    // Clearing it hands the short library back, and the box retires.
    fireEvent.change(
      screen.getByTestId("swarm-persona-search"),
      { target: { value: "" } }
    );
    expect(screen.queryByTestId("swarm-persona-search")).not.toBeInTheDocument();
  });

  it("keeps the editor on the selected persona when a search hides it", async () => {
    // Filtering the rail must not silently repoint the editor — or the agent
    // bridge, which resolves journeys through the selection.
    personaRows.current = many;
    renderPersonasTab();

    fireEvent.change(await screen.findByTestId("swarm-persona-search"), {
      target: { value: "finance" },
    });

    expect(screen.getByLabelText("Name")).toHaveValue("Persona One");
  });
});
