import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientSelector } from "../chat-input/client-selector";
import type { HostListItem } from "@/hooks/useClients";
import type { ClientSelectorData } from "../chat-input/client-selector";

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: navigateMock,
  routePaths: { hosts: "/clients" },
}));
const mockResolveHostLogoByName = vi.hoisted(() => vi.fn());

vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="create-host-dialog" /> : null,
}));

vi.mock("@/lib/host-logo", () => ({
  resolveHostLogoByName: mockResolveHostLogoByName,
}));

const hosts: HostListItem[] = [
  "MCPJam",
  "VS Code",
  "Perplexity",
  "n8n",
  "Mistral",
  "Notion",
  "Goose",
  "Cline",
].map((name, index) => ({
  hostId: `host-${index}`,
  name,
  hostConfigId: `config-${index}`,
  modelId: "openai/gpt-5-mini",
  serverCount: 0,
  createdAt: index,
  updatedAt: index,
}));

function renderClientSelector({
  selectedHostIds = ["host-0"],
  currentHostId = "host-0",
  themeMode,
  modalThemeMode,
}: {
  selectedHostIds?: string[];
  currentHostId?: string;
  themeMode?: "light" | "dark";
  modalThemeMode?: "light" | "dark";
} = {}) {
  return render(
    <ClientSelector
      hosts={hosts}
      projectId="project-1"
      currentHostId={currentHostId}
      selectedHostIds={selectedHostIds}
      onHostChange={vi.fn()}
      onSelectedHostIdsChange={vi.fn()}
      onMultiHostEnabledChange={vi.fn()}
      onPromoteLead={vi.fn()}
      enableMultiHost
      themeMode={themeMode}
      modalThemeMode={modalThemeMode}
    />,
  );
}

describe("ClientSelector", () => {
  beforeEach(() => {
    mockResolveHostLogoByName.mockReset();
    mockResolveHostLogoByName.mockReturnValue("/mcp.svg");
  });

  it("keeps Add host reachable by constraining the host list height", async () => {
    const user = userEvent.setup();
    const { container } = renderClientSelector();

    await user.click(screen.getByTestId("client-selector-trigger"));

    const list = container.ownerDocument.querySelector(
      "[data-slot='command-list']",
    ) as HTMLElement | null;
    expect(list).not.toBeNull();
    expect(list).toHaveStyle({ maxHeight: "220px", overflowY: "auto" });
    expect(screen.getByTestId("client-add-host")).toBeInTheDocument();
  });

  it("shows a fallback badge wherever a client logo is unavailable", async () => {
    const user = userEvent.setup();
    renderClientSelector();

    expect(
      screen.getByTestId("client-selector-trigger").querySelector("img"),
    ).toHaveAttribute("src", expect.stringContaining("mcp"));
    await user.click(screen.getByTestId("client-selector-trigger"));
    expect(
      screen.getByTestId("client-row-host-0").querySelector("img"),
    ).toHaveAttribute("src", expect.stringContaining("mcp"));
  });

  it("uses a shorter scroll area when compare chips are visible", async () => {
    const user = userEvent.setup();
    const { container } = renderClientSelector({
      selectedHostIds: ["host-0", "host-1", "host-3"],
    });

    await user.click(screen.getByTestId("client-selector-trigger"));

    const list = container.ownerDocument.querySelector(
      "[data-slot='command-list']",
    ) as HTMLElement | null;
    expect(list).not.toBeNull();
    expect(list).toHaveStyle({ maxHeight: "160px", overflowY: "auto" });
    expect(screen.getByTestId("client-add-host")).toBeInTheDocument();
  });

  it("only shows the Global badge when comparing multiple hosts", async () => {
    const user = userEvent.setup();
    const { rerender } = renderClientSelector();

    await user.click(screen.getByTestId("client-selector-trigger"));
    expect(screen.queryByText("Global")).not.toBeInTheDocument();

    rerender(
      <ClientSelector
        hosts={hosts}
        projectId="project-1"
        currentHostId="host-0"
        selectedHostIds={["host-0", "host-1"]}
        onHostChange={vi.fn()}
        onSelectedHostIdsChange={vi.fn()}
        onMultiHostEnabledChange={vi.fn()}
        onPromoteLead={vi.fn()}
        enableMultiHost
      />,
    );

    expect(screen.getByText("Global")).toBeInTheDocument();
  });

  // The lead ("Global") row must be uncheckable like any other. The
  // selector only reports the shorter line-up; promoting the new slot 0
  // is `usePersistedHost`'s job — see its "drops the lead" tests.
  it("removes the lead host when its row is unchecked while comparing", async () => {
    const user = userEvent.setup();
    const onSelectedHostIdsChange = vi.fn();
    render(
      <ClientSelector
        hosts={hosts}
        projectId="project-1"
        currentHostId="host-0"
        selectedHostIds={["host-0", "host-1", "host-3"]}
        onHostChange={vi.fn()}
        onSelectedHostIdsChange={onSelectedHostIdsChange}
        onMultiHostEnabledChange={vi.fn()}
        onPromoteLead={vi.fn()}
        enableMultiHost
      />,
    );

    await user.click(screen.getByTestId("client-selector-trigger"));
    expect(screen.getByText("Global")).toBeInTheDocument();

    await user.click(screen.getByTestId("client-row-compare-host-0"));

    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-1", "host-3"]);
  });

  // PUR-11: no more "Multiple clients" switch to find and flip — ticking a
  // second row's checkbox multi-selects immediately, from a single-host
  // line-up and with no prior "enabled" state for the selector to consult.
  // BB-135 moved that gesture off the row body onto the checkbox so the row
  // body can switch clients; the "no toggle to find" property is unchanged.
  it("has no 'Multiple clients' toggle — ticking a second checkbox multi-selects by default", async () => {
    const user = userEvent.setup();
    const onSelectedHostIdsChange = vi.fn();
    const onMultiHostEnabledChange = vi.fn();
    render(
      <ClientSelector
        hosts={hosts}
        projectId="project-1"
        currentHostId="host-0"
        selectedHostIds={["host-0"]}
        onHostChange={vi.fn()}
        onSelectedHostIdsChange={onSelectedHostIdsChange}
        onMultiHostEnabledChange={onMultiHostEnabledChange}
        onPromoteLead={vi.fn()}
        enableMultiHost
      />,
    );

    await user.click(screen.getByTestId("client-selector-trigger"));

    expect(screen.queryByText("Multiple clients")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Compare multiple clients"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId("client-row-compare-host-1"));

    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-0", "host-1"]);
    // No manual toggle exists anymore — the component keeps the parent's
    // persisted "comparing" flag in sync with the selection count itself.
    expect(onMultiHostEnabledChange).toHaveBeenCalledWith(true);
  });

  // Switching out of a comparison is the row's "Only" button; the row body
  // toggles there, like the checkbox.
  it("switches the lead client from Only and leaves compare", async () => {
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    const onSelectedHostIdsChange = vi.fn();
    const onMultiHostEnabledChange = vi.fn();
    render(
      <ClientSelector
        hosts={hosts}
        projectId="project-1"
        currentHostId="host-0"
        selectedHostIds={["host-0", "host-1"]}
        onHostChange={onHostChange}
        onSelectedHostIdsChange={onSelectedHostIdsChange}
        onMultiHostEnabledChange={onMultiHostEnabledChange}
        onPromoteLead={vi.fn()}
        enableMultiHost
      />
    );

    await user.click(screen.getByTestId("client-selector-trigger"));
    await user.click(screen.getByTestId("client-row-only-host-1"));

    expect(onHostChange).toHaveBeenCalledWith("host-1");
    // Clearing the lineup is not cosmetic: `usePersistedHost` preserves the
    // column COUNT when only the lead changes, so leaving it alone would swap
    // a compare column instead of leaving compare.
    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-1"]);
    expect(onMultiHostEnabledChange).toHaveBeenCalledWith(false);
    // Switching is a terminal gesture — the list goes away with the choice.
    expect(screen.queryByTestId("client-row-host-1")).not.toBeInTheDocument();
  });

  it("switches the lead client on a row click when not comparing", async () => {
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    const onSelectedHostIdsChange = vi.fn();
    render(
      <ClientSelector
        hosts={hosts}
        projectId="project-1"
        currentHostId="host-0"
        selectedHostIds={["host-0"]}
        onHostChange={onHostChange}
        onSelectedHostIdsChange={onSelectedHostIdsChange}
        onMultiHostEnabledChange={vi.fn()}
        onPromoteLead={vi.fn()}
        enableMultiHost
      />
    );

    await user.click(screen.getByTestId("client-selector-trigger"));
    expect(screen.queryByTestId("client-row-only-host-1")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("client-row-host-1"));

    expect(onHostChange).toHaveBeenCalledWith("host-1");
    expect(onSelectedHostIdsChange).not.toHaveBeenCalled();
  });

  it("toggles a client on a row click while comparing, keeping the lineup", async () => {
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    const onSelectedHostIdsChange = vi.fn();
    const onMultiHostEnabledChange = vi.fn();
    render(
      <ClientSelector
        hosts={hosts}
        projectId="project-1"
        currentHostId="host-0"
        selectedHostIds={["host-0", "host-1"]}
        onHostChange={onHostChange}
        onSelectedHostIdsChange={onSelectedHostIdsChange}
        onMultiHostEnabledChange={onMultiHostEnabledChange}
        onPromoteLead={vi.fn()}
        enableMultiHost
      />
    );

    await user.click(screen.getByTestId("client-selector-trigger"));
    await user.click(screen.getByTestId("client-row-host-2"));

    expect(onSelectedHostIdsChange).toHaveBeenLastCalledWith([
      "host-0",
      "host-1",
      "host-2",
    ]);
    expect(onHostChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("client-row-host-2")).toBeInTheDocument();

    await user.click(screen.getByTestId("client-row-host-1"));
    expect(onSelectedHostIdsChange).toHaveBeenLastCalledWith(["host-0"]);
    expect(onMultiHostEnabledChange).toHaveBeenLastCalledWith(false);
  });

  // cmdk's root keydown claims Enter for the highlighted row, so without the
  // checkbox stopping it, Enter on a focused checkbox switched clients.
  it("toggles compare when Enter lands on a focused checkbox", async () => {
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    const onSelectedHostIdsChange = vi.fn();
    render(
      <ClientSelector
        hosts={hosts}
        projectId="project-1"
        currentHostId="host-0"
        selectedHostIds={["host-0"]}
        onHostChange={onHostChange}
        onSelectedHostIdsChange={onSelectedHostIdsChange}
        onMultiHostEnabledChange={vi.fn()}
        onPromoteLead={vi.fn()}
        enableMultiHost
      />
    );

    await user.click(screen.getByTestId("client-selector-trigger"));
    screen.getByTestId("client-row-compare-host-1").focus();
    await user.keyboard("{Enter}");

    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-0", "host-1"]);
    expect(onHostChange).not.toHaveBeenCalled();
  });

  it("adds a compare column from the checkbox without switching the lead", async () => {
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    const onSelectedHostIdsChange = vi.fn();
    render(
      <ClientSelector
        hosts={hosts}
        projectId="project-1"
        currentHostId="host-0"
        selectedHostIds={["host-0"]}
        onHostChange={onHostChange}
        onSelectedHostIdsChange={onSelectedHostIdsChange}
        onMultiHostEnabledChange={vi.fn()}
        onPromoteLead={vi.fn()}
        enableMultiHost
      />
    );

    await user.click(screen.getByTestId("client-selector-trigger"));
    await user.click(screen.getByTestId("client-row-compare-host-1"));

    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-0", "host-1"]);
    expect(onHostChange).not.toHaveBeenCalled();
    // The popover stays open so the user can keep building the lineup.
    expect(screen.getByTestId("client-row-host-1")).toBeInTheDocument();
  });

  // The cap belongs to the comparison, not to the client list: with three
  // columns already up you can still switch to a fourth client.
  it("keeps rows switchable when the compare lineup is full", async () => {
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    render(
      <ClientSelector
        hosts={hosts}
        projectId="project-1"
        currentHostId="host-0"
        selectedHostIds={["host-0", "host-1", "host-2"]}
        onHostChange={onHostChange}
        onSelectedHostIdsChange={vi.fn()}
        onMultiHostEnabledChange={vi.fn()}
        onPromoteLead={vi.fn()}
        enableMultiHost
      />
    );

    await user.click(screen.getByTestId("client-selector-trigger"));
    expect(screen.getByTestId("client-row-compare-host-3")).toBeDisabled();

    // The row body cannot add a fourth pane; Only still switches.
    await user.click(screen.getByTestId("client-row-host-3"));
    expect(onHostChange).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("client-row-only-host-3"));

    expect(onHostChange).toHaveBeenCalledWith("host-3");
  });

  /**
   * Two clients can carry the same stored name — `resolveClientDisplayNames`
   * is what tells them apart, and it does so in `displayName` alone. Naming
   * the button after the raw name gave both rows "Compare with Claude": one
   * button announced twice, and unreachable by voice or by role query.
   */
  it("names the compare button after the client the row shows", async () => {
    const user = userEvent.setup();
    render(
      <ClientSelector
        hosts={[
          // The lead sits elsewhere so BOTH duplicates render the "Compare
          // with" branch, which is where the collision showed.
          { hostId: "host-lead", name: "Cursor", displayName: "Cursor" },
          { hostId: "host-a", name: "Claude", displayName: "Claude" },
          { hostId: "host-b", name: "Claude", displayName: "Claude #2" },
        ]}
        projectId="project-1"
        currentHostId="host-lead"
        selectedHostIds={["host-lead"]}
        onHostChange={vi.fn()}
        onSelectedHostIdsChange={vi.fn()}
        onMultiHostEnabledChange={vi.fn()}
        onPromoteLead={vi.fn()}
        enableMultiHost
      />
    );

    await user.click(screen.getByTestId("client-selector-trigger"));

    expect(
      screen.getByRole("button", { name: "Compare with Claude #2" })
    ).toBeInTheDocument();
    // Exact match, so the raw-name version fails here too: it produced two
    // buttons with this name and the query cannot resolve them.
    expect(
      screen.getByRole("button", { name: "Compare with Claude" })
    ).toBeInTheDocument();
  });

  /**
   * The cap tooltip's only hover surface is the disabled checkbox, so the
   * button drops pointer events and the wrapper takes them. The click has to
   * stop there: falling through to the row would switch the client out from
   * under someone who aimed at a checkbox.
   */
  it("does not switch the lead when the capped checkbox is clicked", async () => {
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    render(
      <ClientSelector
        hosts={hosts}
        projectId="project-1"
        currentHostId="host-0"
        selectedHostIds={["host-0", "host-1", "host-2"]}
        onHostChange={onHostChange}
        onSelectedHostIdsChange={vi.fn()}
        onMultiHostEnabledChange={vi.fn()}
        onPromoteLead={vi.fn()}
        enableMultiHost
      />
    );

    await user.click(screen.getByTestId("client-selector-trigger"));
    const capped = screen.getByTestId("client-row-compare-host-3");
    expect(capped).toBeDisabled();

    // The wrapper is what a pointer actually lands on once the button stops
    // taking events.
    const wrapper = capped.parentElement;
    expect(wrapper).not.toBeNull();
    await user.click(wrapper as HTMLElement);

    expect(onHostChange).not.toHaveBeenCalled();
  });

  it("uses app-surface logo variants inside the modal", async () => {
    const user = userEvent.setup();
    renderClientSelector({
      currentHostId: "host-6",
      selectedHostIds: ["host-6"],
      themeMode: "dark",
      modalThemeMode: "light",
    });

    expect(mockResolveHostLogoByName).toHaveBeenCalledWith("Goose", "dark");

    await user.click(screen.getByTestId("client-selector-trigger"));

    expect(mockResolveHostLogoByName).toHaveBeenCalledWith("Goose", "light");
    expect(mockResolveHostLogoByName).toHaveBeenCalledWith("Cline", "light");
  });
});

it("opens the New Client modal from Add clients when a project exists", async () => {
  renderClientSelector();
  const user = userEvent.setup();
  await user.click(screen.getByTestId("client-selector-trigger"));
  await user.click(screen.getByRole("button", { name: "Add clients" }));
  expect(screen.getByTestId("create-host-dialog")).toBeInTheDocument();
  expect(navigateMock).not.toHaveBeenCalled();
});

it("sends Add clients to Connect when the picker has no creation project", async () => {
  render(
    <ClientSelector
      hosts={hosts}
      projectId={null}
      currentHostId="host-0"
      selectedHostIds={["host-0"]}
      onHostChange={vi.fn()}
      onSelectedHostIdsChange={vi.fn()}
      onMultiHostEnabledChange={vi.fn()}
      onPromoteLead={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByTestId("client-selector-trigger"));
  await user.click(screen.getByRole("button", { name: "Add clients" }));
  expect(navigateMock).toHaveBeenCalledWith("/clients");
});

describe("ClientSelector with environment panes", () => {
  const environments = [
    { paneId: "env_1", label: "E1" },
    { paneId: "env_2", label: "E2" },
  ];

  function renderLineup({
    selectedHostIds = [] as string[],
    maxSelectedHosts = 1,
  } = {}) {
    const calls = {
      onHostChange: vi.fn(),
      onSelectedHostIdsChange: vi.fn(),
      onMultiHostEnabledChange: vi.fn(),
      onRemovePane: vi.fn(),
      onPickSingleClient: vi.fn(),
    };
    render(
      <ClientSelector
        hosts={hosts}
        projectId="project-1"
        cloudProjectId={null}
        // The previewed client, which runs no pane in this lineup.
        currentHostId="host-0"
        selectedHostIds={selectedHostIds}
        onPromoteLead={vi.fn()}
        enableMultiHost
        maxSelectedHosts={maxSelectedHosts}
        environmentPanes={environments}
        environmentLeads
        {...calls}
      />,
    );
    return calls;
  }

  beforeEach(() => {
    mockResolveHostLogoByName.mockReturnValue("/mcp.svg");
  });

  it("shows two environment panes and no client that has no pane", async () => {
    const user = userEvent.setup();
    renderLineup();
    const trigger = screen.getByTestId("client-selector-trigger");
    expect(trigger).toHaveAccessibleName("Compare panes: E1, E2");
    expect(trigger).not.toHaveTextContent("MCPJam");

    await user.click(trigger);
    expect(screen.getByRole("button", { name: "Remove E1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove E2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove MCPJam" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Compare with MCPJam" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("adds a client beside them and removes an environment pane", async () => {
    const user = userEvent.setup();
    const calls = renderLineup();
    await user.click(screen.getByTestId("client-selector-trigger"));
    await user.click(screen.getByRole("button", { name: "Compare with VS Code" }));
    expect(calls.onSelectedHostIdsChange).toHaveBeenLastCalledWith(["host-1"]);
    expect(calls.onMultiHostEnabledChange).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole("button", { name: "Remove E2" }));
    expect(calls.onRemovePane).toHaveBeenCalledWith("env_2");
  });

  it("lets the last client go while environment panes stay, and counts them toward the cap", async () => {
    const user = userEvent.setup();
    const calls = renderLineup({ selectedHostIds: ["host-1"] });
    expect(screen.getByTestId("client-selector-trigger")).toHaveAccessibleName(
      "Compare panes: E1, E2, VS Code",
    );
    await user.click(screen.getByTestId("client-selector-trigger"));
    expect(
      screen.getByText("Remove a pane to add another client."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Compare with MCPJam" }),
    ).toBeDisabled();

    await user.click(
      screen.getByRole("button", { name: "Remove VS Code from comparison" }),
    );
    expect(calls.onSelectedHostIdsChange).toHaveBeenLastCalledWith([]);
    expect(calls.onMultiHostEnabledChange).toHaveBeenLastCalledWith(true);
  });

  it("leaves Compare for one client when its Only is picked", async () => {
    const user = userEvent.setup();
    const calls = renderLineup();
    await user.click(screen.getByTestId("client-selector-trigger"));
    await user.click(screen.getByTestId("client-row-only-host-2"));
    expect(calls.onPickSingleClient).toHaveBeenCalledWith("host-2");
    expect(calls.onSelectedHostIdsChange).not.toHaveBeenCalled();
    expect(calls.onMultiHostEnabledChange).toHaveBeenLastCalledWith(false);
  });
});

// The Playground mounts its composer in one subtree for a single chat and in
// another for Compare, so the first ticked client remounts the selector.
function RemountingPlayground() {
  const [selectedHostIds, setSelectedHostIds] = useState(["host-0"]);
  const comparing = selectedHostIds.length > 1;
  const selector: ClientSelectorData = {
    hosts,
    projectId: "project-1",
    cloudProjectId: null,
    currentHostId: "host-0",
    selectedHostIds,
    onHostChange: vi.fn(),
    onSelectedHostIdsChange: setSelectedHostIds,
    onMultiHostEnabledChange: vi.fn(),
    onPromoteLead: vi.fn(),
    enableMultiHost: true,
  };
  return comparing ? (
    <section data-testid="compare-layout">
      <ClientSelector {...selector} />
    </section>
  ) : (
    <main data-testid="single-layout">
      <ClientSelector {...selector} />
    </main>
  );
}

it("stays open when the first ticked client remounts it into Compare", async () => {
  render(<RemountingPlayground />);
  const user = userEvent.setup();
  await user.click(screen.getByTestId("client-selector-trigger"));
  await user.click(screen.getByTestId("client-row-compare-host-1"));

  expect(screen.getByTestId("compare-layout")).toBeInTheDocument();
  expect(screen.getByPlaceholderText("Search clients")).toBeInTheDocument();

  await user.click(screen.getByTestId("client-row-compare-host-2"));
  expect(screen.getByTestId("client-row-compare-host-2")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("opens closed after unmounting closed", async () => {
  const { unmount } = renderClientSelector();
  unmount();
  renderClientSelector();
  expect(
    screen.queryByPlaceholderText("Search clients"),
  ).not.toBeInTheDocument();
});
