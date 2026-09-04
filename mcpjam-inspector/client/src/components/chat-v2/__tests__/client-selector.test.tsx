import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientSelector } from "../chat-input/client-selector";
import type { HostListItem } from "@/hooks/useClients";

const mockResolveHostLogoByDisplayName = vi.hoisted(() => vi.fn());

vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: () => null,
}));

vi.mock("@/lib/scenario-client-style", () => ({
  resolveHostLogoByDisplayName: mockResolveHostLogoByDisplayName,
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
    />
  );
}

describe("ClientSelector", () => {
  beforeEach(() => {
    mockResolveHostLogoByDisplayName.mockReset();
    mockResolveHostLogoByDisplayName.mockReturnValue(null);
  });

  it("keeps Add host reachable by constraining the host list height", async () => {
    const user = userEvent.setup();
    const { container } = renderClientSelector();

    await user.click(screen.getByTestId("client-selector-trigger"));

    const list = container.ownerDocument.querySelector(
      "[data-slot='command-list']"
    ) as HTMLElement | null;
    expect(list).not.toBeNull();
    expect(list).toHaveStyle({ maxHeight: "220px", overflowY: "auto" });
    expect(screen.getByTestId("client-add-host")).toBeInTheDocument();
  });

  it("uses a shorter scroll area when compare chips are visible", async () => {
    const user = userEvent.setup();
    const { container } = renderClientSelector({
      selectedHostIds: ["host-0", "host-1", "host-3"],
    });

    await user.click(screen.getByTestId("client-selector-trigger"));

    const list = container.ownerDocument.querySelector(
      "[data-slot='command-list']"
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
      />
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
      />
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
      />
    );

    await user.click(screen.getByTestId("client-selector-trigger"));

    expect(screen.queryByText("Multiple clients")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Compare multiple clients")
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId("client-row-compare-host-1"));

    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-0", "host-1"]);
    // No manual toggle exists anymore — the component keeps the parent's
    // persisted "comparing" flag in sync with the selection count itself.
    expect(onMultiHostEnabledChange).toHaveBeenCalledWith(true);
  });

  // BB-135: switching clients used to mean "tick the one you want, then untick
  // the one you had" — the row body only ever multi-selected.
  it("switches the lead client on a row click and leaves compare", async () => {
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
    await user.click(screen.getByTestId("client-row-host-1"));

    expect(onHostChange).toHaveBeenCalledWith("host-1");
    // Clearing the lineup is not cosmetic: `usePersistedHost` preserves the
    // column COUNT when only the lead changes, so leaving it alone would swap
    // a compare column instead of leaving compare.
    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-1"]);
    expect(onMultiHostEnabledChange).toHaveBeenCalledWith(false);
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

    await user.click(screen.getByTestId("client-row-host-3"));

    expect(onHostChange).toHaveBeenCalledWith("host-3");
  });

  it("uses app-surface logo variants inside the modal", async () => {
    const user = userEvent.setup();
    renderClientSelector({
      currentHostId: "host-6",
      selectedHostIds: ["host-6"],
      themeMode: "dark",
      modalThemeMode: "light",
    });

    expect(mockResolveHostLogoByDisplayName).toHaveBeenCalledWith(
      "Goose",
      "dark"
    );

    await user.click(screen.getByTestId("client-selector-trigger"));

    expect(mockResolveHostLogoByDisplayName).toHaveBeenCalledWith(
      "Goose",
      "light"
    );
    expect(mockResolveHostLogoByDisplayName).toHaveBeenCalledWith(
      "Cline",
      "light"
    );
  });
});
