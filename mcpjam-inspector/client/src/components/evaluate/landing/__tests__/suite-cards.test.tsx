import userEvent from "@testing-library/user-event";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));

vi.mock("@/lib/host-logo", () => ({
  resolveHostLogoByName: () => "logo.png",
}));

vi.mock("date-fns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("date-fns")>();
  return { ...actual, formatDistanceToNow: () => "about 1 hour ago" };
});

import { SuiteCards, type SuiteCardsProps } from "../suite-cards";
import {
  makeEntry,
  makeRun,
  makeSuite,
  sampleEntry,
} from "./suite-card-fixtures";

function renderCards(overrides: Partial<SuiteCardsProps> = {}) {
  const props: SuiteCardsProps = {
    rows: [
      {
        entry: sampleEntry("Excalidraw quickstart"),
        models: ["anthropic/claude-haiku-4.5"],
        clients: ["MCPJam"],
      },
    ],
    onOpenSuite: vi.fn(),
    onOpenRun: vi.fn(),
    onOpenSettings: vi.fn(),
    onRunSuite: vi.fn(),
    onCancelRun: vi.fn(),
    rerunningSuiteId: null,
    cancellingRunId: null,
    ...overrides,
  };
  render(<SuiteCards {...props} />);
  return props;
}

function card(name: string) {
  return within(
    screen
      .getAllByTestId("nav-suite-overview-row")
      .find((row) => row.textContent?.includes(name))!,
  );
}

describe("SuiteCards", () => {
  it("writes the card's strings", () => {
    renderCards();
    const row = card("Excalidraw quickstart");
    expect(row.getByText("75%")).toBeInTheDocument();
    expect(row.getByText("average across the last 6 runs")).toBeInTheDocument();
    expect(row.getByText("Flaky")).toHaveClass("text-warning");
    expect(row.getByText("· passed 2 of 5")).toBeInTheDocument();
    expect(row.getByRole("button", { name: "Run #6" })).toBeInTheDocument();
    expect(row.getByText("Failed 67%")).toHaveClass("text-destructive");
    expect(row.getByText("about 1 hour ago")).toBeInTheDocument();
    expect(row.getByTestId("nav-suite-dot")).toHaveClass("bg-destructive");
    expect(
      row
        .getAllByTestId("nav-suite-bar")
        .map((bar) => bar.getAttribute("aria-label")),
    ).toEqual([
      "Run #2, failed, 67%",
      "Run #3, passed, 97%",
      "Run #4, failed, 88%",
      "Run #5, passed, 92%",
      "Run #6, failed, 67%",
    ]);
    expect(
      row.getByRole("button", { name: /^Run Excalidraw/ }),
    ).toHaveTextContent("Run");
    expect(row.queryByText(/test cases?/)).toBeNull();
    expect(row.queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("shows the empty and passing states", () => {
    renderCards({
      rows: [
        {
          entry: makeEntry(makeSuite("empty", { name: "" }), []),
          models: [null],
          clients: [],
        },
        {
          entry: sampleEntry("Excalidraw basics (Sonnet)"),
          models: ["a", "b"],
          clients: ["MCPJam", "Claude"],
        },
      ],
    });
    const empty = card("Untitled suite");
    expect(empty.getByText("—")).toBeInTheDocument();
    expect(empty.getAllByText("No runs yet")).toHaveLength(2);
    expect(
      empty.getByText("Run it once to start a trend."),
    ).toBeInTheDocument();
    expect(empty.queryByTitle("Model")).toBeNull();
    expect(empty.queryByTitle("Client")).toBeNull();
    expect(empty.getByTestId("nav-suite-dot")).toHaveClass(
      "bg-muted-foreground",
    );
    const sonnet = card("Excalidraw basics");
    expect(sonnet.getByText("Steady")).toBeInTheDocument();
    expect(sonnet.getByText("Passed 100%")).toHaveClass("text-success");
    expect(sonnet.getByTitle("Model")).toHaveTextContent("+1");
    expect(sonnet.getByTitle("Client")).toHaveTextContent("Client: MCPJam +1");
    expect(sonnet.getByTestId("nav-suite-dot")).toHaveClass("bg-success");
  });

  it("opens the suite, a run, and settings", async () => {
    const user = userEvent.setup();
    const props = renderCards();
    const row = card("Excalidraw quickstart");
    await user.click(row.getByText("Excalidraw quickstart"));
    expect(props.onOpenSuite).toHaveBeenCalledWith("Excalidraw-quickstart");
    await user.click(row.getByRole("button", { name: "Run #3, passed, 97%" }));
    expect(props.onOpenRun).toHaveBeenCalledWith({
      suiteId: "Excalidraw-quickstart",
      runId: "Excalidraw-quickstart-run-3",
    });
    await user.click(row.getByRole("button", { name: "Run #6" }));
    expect(props.onOpenRun).toHaveBeenLastCalledWith({
      suiteId: "Excalidraw-quickstart",
      runId: "Excalidraw-quickstart-run-6",
    });
    await user.click(row.getByRole("button", { name: "Suite settings" }));
    expect(props.onOpenSettings).toHaveBeenCalledWith("Excalidraw-quickstart");
    await user.click(row.getByRole("button", { name: /^Run Excalidraw/ }));
    expect(props.onRunSuite).toHaveBeenCalledOnce();
  });

  it("cancels the whole active launch and spins while it cancels", async () => {
    const user = userEvent.setup();
    const a = makeRun("s", 1, { status: "running", runGroupId: "g" });
    const b = makeRun("s", 2, { status: "running", runGroupId: "g" });
    const rows = [
      { entry: makeEntry(makeSuite("s"), [a, b]), models: [], clients: [] },
    ];
    const props = renderCards({ rows });
    expect(screen.getByText("Running")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel run for s" }));
    expect(props.onCancelRun).toHaveBeenCalledWith(
      expect.arrayContaining([a._id, b._id]),
    );
  });

  it("disables Cancel while a cancel is in flight", () => {
    const run = makeRun("s", 1, { status: "running" });
    renderCards({
      rows: [
        { entry: makeEntry(makeSuite("s"), [run]), models: [], clients: [] },
      ],
      cancellingRunId: "elsewhere",
    });
    expect(
      screen.getByRole("button", { name: "Cancel run for s" }),
    ).toBeDisabled();
  });

  it("shows the starting spinner and the no-servers state", () => {
    renderCards({
      rows: [
        { entry: makeEntry(makeSuite("s"), []), models: [], clients: [] },
        {
          entry: makeEntry(
            makeSuite("t", { environment: { servers: [] } }),
            [],
          ),
          models: [],
          clients: [],
        },
      ],
      rerunningSuiteId: "s",
    });
    expect(screen.getByRole("button", { name: "Running s" })).toBeDisabled();
    const noServers = screen.getByRole("button", {
      name: "No servers configured",
    });
    expect(noServers).toBeDisabled();
    expect(noServers).toHaveAttribute("title", "No servers configured");
  });

  it("searches and sorts", async () => {
    const user = userEvent.setup();
    renderCards({
      rows: [
        {
          entry: sampleEntry("Excalidraw quickstart"),
          models: [],
          clients: [],
        },
        {
          entry: sampleEntry("Asana onboarding smoke"),
          models: [],
          clients: [],
        },
      ],
    });
    await user.type(
      screen.getByRole("searchbox", { name: "Search suites" }),
      " asana ",
    );
    expect(screen.getAllByTestId("nav-suite-overview-row")).toHaveLength(1);
    await user.clear(screen.getByRole("searchbox", { name: "Search suites" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search suites" }),
      "zzz",
    );
    expect(screen.getByText("No suites match “zzz”.")).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search suites" }));

    await user.click(
      screen.getByRole("button", { name: "Sort suites by Last run" }),
    );
    expect(
      screen.getByRole("menuitemradio", { name: "Last run" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemradio", { name: "Name" }));
    expect(
      screen
        .getAllByTestId("nav-suite-overview-row")
        .map((row) => row.getAttribute("data-suite-id")),
    ).toEqual(["Asana-onboarding-smoke", "Excalidraw-quickstart"]);
    expect(
      screen.getByRole("button", { name: "Sort suites by Name" }),
    ).toBeInTheDocument();
  });
});
