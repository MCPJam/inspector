/**
 * The persona sidebar card.
 *
 * jsdom has no layout engine, so truncation is invisible here. This file
 * asserts the layout classes sit on the right elements;
 * `e2e/personas-column-layout.spec.ts` measures what they render to.
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

/** Long enough to wrap; "Ana" below is the short control. */
const LONG_NAME = "Responsable de compras corporativas del segmento enterprise";
const LONG_ROLE = "Evalúa integraciones con deadline encima y aprueba vendors";

const personas = [
  {
    _id: "persona-1",
    personaId: "p1",
    name: LONG_NAME,
    role: LONG_ROLE,
    notes: "",
  },
  { _id: "persona-2", personaId: "p2", name: "Ana", role: "QA", notes: "" },
];

// Mocked hooks must return stable identities: a fresh `[]` or `vi.fn()` per
// call re-triggers the effects downstream and loops SwarmsTab forever.
const { personaRows, EMPTY, mutationFor, paginated } = vi.hoisted(() => {
  const EMPTY: never[] = [];
  const mutations = new Map<string, ReturnType<typeof vi.fn>>();
  return {
    personaRows: { current: [] as Record<string, unknown>[] },
    EMPTY,
    mutationFor: (name: string) => {
      if (!mutations.has(name)) {
        mutations.set(name, vi.fn().mockResolvedValue(undefined));
      }
      return mutations.get(name)!;
    },
    paginated: {
      results: EMPTY,
      status: "Exhausted",
      loadMore: vi.fn(),
      isLoading: false,
    },
  };
});

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return personaRows.current;
      case "journeys:listJourneysByPersona":
      case "hosts:listHosts":
      case "journeyRuns:listRunningPersonaRefIds":
        return EMPTY;
      default:
        return undefined;
    }
  },
  useMutation: (name: string) => mutationFor(name),
  usePaginatedQuery: () => paginated,
}));

vi.mock("@/lib/swarm-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarm-api")>();
  return { ...actual, launchJourneyRun: vi.fn() };
});
vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));
vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: () => null,
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

/** The sidebar; the detail pane renders the same name. */
async function renderSidebar(): Promise<HTMLElement> {
  render(<SwarmsTab projectId="proj-1" isAuthenticated />);
  openPersonasTab();
  const aside = await screen.findByTestId("swarm-persona-sidebar");
  await waitFor(() => {
    expect(within(aside).getByText("Ana")).toBeTruthy();
  });
  return aside;
}

describe("persona sidebar card", () => {
  beforeEach(() => {
    personaRows.current = personas;
  });

  it("hands the full name and role back on hover", async () => {
    const aside = await renderSidebar();

    expect(within(aside).getByText(LONG_NAME)).toHaveAttribute(
      "title",
      LONG_NAME,
    );
    expect(within(aside).getByText(LONG_ROLE)).toHaveAttribute(
      "title",
      LONG_ROLE,
    );
  });

  it("titles even a short name, so hover never depends on guessing", async () => {
    const aside = await renderSidebar();

    // Unconditional: whether a name is elided depends on the viewport.
    expect(within(aside).getByText("Ana")).toHaveAttribute("title", "Ana");
    expect(within(aside).getByText("QA")).toHaveAttribute("title", "QA");
  });

  it("clamps the name to two lines and keeps the role on one", async () => {
    const aside = await renderSidebar();
    const name = within(aside).getByText(LONG_NAME);
    const role = within(aside).getByText(LONG_ROLE);

    expect(name.className).toContain("line-clamp-2");
    // truncate carries white-space:nowrap, which would cancel the clamp.
    expect(name.className).not.toContain("truncate");
    expect(role.className).toContain("truncate");
  });

  it("bounds both lines to the column instead of to their own text", async () => {
    const aside = await renderSidebar();
    const name = within(aside).getByText(LONG_NAME);

    // items-start would size each line to its own text, not to the column.
    const textColumn = name.parentElement;
    expect(textColumn).not.toBeNull();
    expect(textColumn!.className).not.toContain("items-start");

    expect(name.className).toContain("w-full");
    expect(within(aside).getByText(LONG_ROLE).className).toContain("w-full");
  });

  it("forbids the horizontal axis on the persona list", async () => {
    const aside = await renderSidebar();

    // overflow-y-auto alone leaves overflow-x computed as auto.
    const scroller = aside.querySelector(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    expect(scroller!.className).toContain("overflow-x-hidden");
  });

  it("reserves the same height on every card", async () => {
    const aside = await renderSidebar();
    const rows = within(aside)
      .getAllByRole("button")
      .filter((el) => el.className.includes("min-h-"));

    expect(rows).toHaveLength(personas.length);
    const heights = new Set(
      rows.map((el) => el.className.match(/min-h-\[\d+px\]/)?.[0]),
    );
    expect(heights.size).toBe(1);
    expect([...heights][0]).toBeDefined();
  });

  /** The row wrapping a card, which carries the selected background. */
  const rowOf = (nameEl: HTMLElement) =>
    nameEl.closest("button")?.parentElement;

  it("marks the selected card and only that one", async () => {
    const aside = await renderSidebar();
    // SwarmsTab lands on the first persona, so the second is the one to click.
    expect(rowOf(within(aside).getByText(LONG_NAME))?.className).toContain(
      "bg-muted",
    );

    fireEvent.click(within(aside).getByText("Ana"));

    await waitFor(() => {
      expect(rowOf(within(aside).getByText("Ana"))?.className).toContain(
        "bg-muted",
      );
    });
    expect(rowOf(within(aside).getByText(LONG_NAME))?.className).not.toContain(
      "bg-muted",
    );
  });

  it("offers a way out of an empty library", async () => {
    personaRows.current = [];
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    const aside = await screen.findByTestId("swarm-persona-sidebar");

    expect(within(aside).getByText(/no saved personas yet/i)).toBeTruthy();
    expect(
      within(aside).getByRole("button", { name: /create a persona/i }),
    ).toBeTruthy();
  });

  it("says it is loading rather than showing an empty library", async () => {
    personaRows.current = undefined as never;
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    const aside = await screen.findByTestId("swarm-persona-sidebar");

    expect(within(aside).getByText(/loading/i)).toBeTruthy();
    expect(within(aside).queryByText(/no saved personas yet/i)).toBeNull();
  });
});
