/**
 * Personas create/edit UX on SwarmsTab — dialog create + blur-save profile notes.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  runningPersonaRefIds,
} = vi.hoisted(() => ({
  createPersonaMutation: vi.fn(),
  updatePersonaMutation: vi.fn(),
  runningPersonaRefIds: { current: [] as string[] },
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return [persona];
      case "journeys:listJourneysByPersona":
        return [];
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
  useDbUserReady: () => true,
}));
vi.mock("@/lib/chatbox-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { SwarmsTab } from "../SwarmsTab";

beforeEach(() => {
  vi.clearAllMocks();
  runningPersonaRefIds.current = [];
  createPersonaMutation.mockResolvedValue({ _id: "persona-new" });
  updatePersonaMutation.mockResolvedValue({ ...persona });
});

describe("SwarmsTab — persona create/edit", () => {
  it("opens a labeled create dialog instead of a floating raw form", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);

    fireEvent.click(screen.getByRole("button", { name: /new/i }));

    expect(screen.getByRole("heading", { name: "New persona" })).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Role")).toBeTruthy();
    expect(screen.getByLabelText("Notes / personality")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Nacho" },
    });
    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "SWE" },
    });
    fireEvent.change(screen.getByLabelText("Notes / personality"), {
      target: { value: "pragmatic" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create persona/i }));

    await waitFor(() => {
      expect(createPersonaMutation).toHaveBeenCalledWith({
        projectId: "proj-1",
        name: "Nacho",
        role: "SWE",
        notes: "pragmatic",
      });
    });
  });

  it("saves personality notes on blur via updatePersona", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(screen.getByText("Persona One"));

    const notes = screen.getByLabelText("Notes / personality");
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
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(screen.getByText("Persona One"));

    // Sidebar + detail header both render the name; edit the detail copy.
    const nameLabels = screen.getAllByText("Persona One");
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

  it("saves avatar look changes from the picker via updatePersona", async () => {
    const { resolvePersonaPixelLook } = await import(
      "../persona-pixel-avatar"
    );
    const seeded = resolvePersonaPixelLook("persona-1");

    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(screen.getByText("Persona One"));

    fireEvent.click(screen.getByTestId("persona-avatar-look-trigger"));
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
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);

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
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(await screen.findByText("Persona One"));

    await waitFor(() => {
      const aside = screen.getByRole("complementary");
      const avatar = within(aside).getByTestId("persona-pixel-avatar");
      expect(avatar.getAttribute("data-state")).toBe("idle");
      expect(avatar.getAttribute("data-busy")).toBe("false");
    });
  });
});

