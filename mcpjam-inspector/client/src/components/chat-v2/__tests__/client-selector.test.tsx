import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientSelector } from "../chat-input/client-selector";
import type { HostListItem } from "@/hooks/useClients";

const mockResolveHostLogoByName = vi.hoisted(() => vi.fn());

vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: () => null,
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
    />
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
      "[data-slot='command-list']"
    ) as HTMLElement | null;
    expect(list).not.toBeNull();
    expect(list).toHaveStyle({ maxHeight: "220px", overflowY: "auto" });
    expect(screen.getByTestId("client-add-host")).toBeInTheDocument();
  });

  it("shows a fallback badge wherever a client logo is unavailable", async () => {
    const user = userEvent.setup();
    renderClientSelector();

    expect(
      screen.getByTestId("client-selector-trigger").querySelector("img")
    ).toHaveAttribute("src", expect.stringContaining("mcp"));
    await user.click(screen.getByTestId("client-selector-trigger"));
    expect(
      screen.getByTestId("client-row-host-0").querySelector("img")
    ).toHaveAttribute("src", expect.stringContaining("mcp"));
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

    await user.click(screen.getByTestId("client-row-host-0"));

    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-1", "host-3"]);
  });

  // PUR-11: no more "Multiple clients" switch to find and flip — checking a
  // second row multi-selects immediately, from a single-host line-up and with
  // no prior "enabled" state anywhere for the selector to consult.
  it("has no 'Multiple clients' toggle — checking a second row multi-selects by default", async () => {
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

    await user.click(screen.getByTestId("client-row-host-1"));

    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-0", "host-1"]);
    // No manual toggle exists anymore — the component keeps the parent's
    // persisted "comparing" flag in sync with the selection count itself.
    expect(onMultiHostEnabledChange).toHaveBeenCalledWith(true);
  });

  it("uses app-surface logo variants inside the modal", async () => {
    const user = userEvent.setup();
    renderClientSelector({
      currentHostId: "host-6",
      selectedHostIds: ["host-6"],
      themeMode: "dark",
      modalThemeMode: "light",
    });

    expect(mockResolveHostLogoByName).toHaveBeenCalledWith(
      "Goose",
      "dark"
    );

    await user.click(screen.getByTestId("client-selector-trigger"));

    expect(mockResolveHostLogoByName).toHaveBeenCalledWith(
      "Goose",
      "light"
    );
    expect(mockResolveHostLogoByName).toHaveBeenCalledWith(
      "Cline",
      "light"
    );
  });
});
