import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientSelector } from "../chat-input/client-selector";
import type { HostListItem } from "@/hooks/useClients";

const mockResolveHostLogoByDisplayName = vi.hoisted(() => vi.fn());

vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: () => null,
}));

vi.mock("@/lib/chatbox-client-style", () => ({
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
  multiHostEnabled = false,
  selectedHostIds = ["host-0"],
  currentHostId = "host-0",
  themeMode,
  modalThemeMode,
}: {
  multiHostEnabled?: boolean;
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
      multiHostEnabled={multiHostEnabled}
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
      multiHostEnabled: true,
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
        multiHostEnabled
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
        multiHostEnabled
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
