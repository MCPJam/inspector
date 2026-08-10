import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { HostOverlayBar } from "@/components/hosts/HostOverlayBar";

vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: () => null,
}));

const mockUseHostList = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: (...args: unknown[]) => mockUseHostList(...args),
  useHostMutations: () => ({
    createHost: vi.fn(),
    updateHost: vi.fn(),
    deleteHost: vi.fn().mockResolvedValue(undefined),
    duplicateHost: vi.fn(),
  }),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({ servers: [] }),
}));

vi.mock("@/lib/host-compat/use-host-catalog", () => ({
  useHostCatalog: () => ({
    status: "loading",
    catalog: null,
    version: null,
    source: null,
  }),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (
    selector: (state: { themeMode: "light" | "dark" }) => unknown
  ) => selector({ themeMode: "light" }),
}));

vi.mock("@/lib/analytics", () => ({
  track: vi.fn(),
}));

const oneHost = [
  {
    hostId: "host-a",
    name: "MCPJam",
    hostConfigId: "cfg-1",
    modelId: "x",
    serverCount: 0,
    createdAt: 1,
    updatedAt: 1,
  },
];

const twoHosts = [
  ...oneHost,
  {
    hostId: "host-b",
    name: "Claude",
    hostConfigId: "cfg-2",
    modelId: "y",
    serverCount: 0,
    createdAt: 2,
    updatedAt: 2,
  },
];

describe("HostOverlayBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseHostList.mockReturnValue({ hosts: oneHost, isLoading: false });
  });

  it("lays out the toolbar like the redesigned host builder header row", () => {
    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />
    );

    const bar = screen.getByTestId("host-overlay-bar");
    expect(bar).toHaveClass("min-w-0", "items-center");
  });

  it("exposes prev/next arrows and a current-host dropdown trigger", () => {
    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />
    );

    expect(screen.getByTestId("host-overlay-prev")).toBeInTheDocument();
    expect(screen.getByTestId("host-overlay-current")).toHaveTextContent(
      "MCPJam"
    );
    expect(screen.getByTestId("host-overlay-next")).toBeInTheDocument();
  });

  it("renders per-row edit/delete actions and a save-as-new entry inside the dropdown", async () => {
    const user = userEvent.setup();
    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Client used for preview" })
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overlay-edit-host-a")
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("host-overlay-delete-host-a")
    ).toBeInTheDocument();
    expect(screen.getByTestId("host-overlay-save-as-new")).toBeVisible();
  });

  it("renders a client logo on every dropdown row", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });

    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Client used for preview" })
    );

    const logoA = await screen.findByTestId("host-overlay-logo-host-a");
    expect(logoA).toHaveAttribute("src", expect.stringContaining("mcp_jam"));
    expect(screen.getByTestId("host-overlay-logo-host-b")).toHaveAttribute(
      "src",
      expect.stringContaining("claude")
    );
  });

  it("falls back to the generic MCP mark for a client it cannot place", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({
      hosts: [{ ...oneHost[0], name: "Acme Internal Bot" }],
      isLoading: false,
    });

    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Client used for preview" })
    );

    // Not an empty circle — HostCanvasSelector shows /mcp.svg for the same
    // unknown-name case, and the two pickers must agree.
    const logo = await screen.findByTestId("host-overlay-logo-host-a");
    expect(logo.tagName).toBe("IMG");
    expect(logo).toHaveAttribute("src", "/mcp.svg");
  });

  it("places a decorated client name the exact-match resolver would miss", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({
      hosts: [{ ...oneHost[0], name: "Cursor (staging)" }],
      isLoading: false,
    });

    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Client used for preview" })
    );

    expect(await screen.findByTestId("host-overlay-logo-host-a")).toHaveAttribute(
      "src",
      expect.stringContaining("cursor")
    );
  });

  it("marks the selected row with a single primary-colored dot", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });

    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Client used for preview" })
    );

    // Only the previewed host gets a dot, so the design-system's built-in
    // left-gutter indicator must be gone — two dots would read as two
    // selections.
    const dots = await screen.findAllByTestId(/^host-overlay-selected-dot-/);
    expect(dots).toHaveLength(1);
    expect(dots[0]).toHaveAttribute(
      "data-testid",
      "host-overlay-selected-dot-host-a"
    );
    expect(dots[0]).toHaveClass("bg-primary");

    const row = screen.getByRole("menuitemradio", { name: /MCPJam/ });
    expect(row.querySelector("span.absolute")).toBeNull();
  });

  it("places the selected dot after the client name so logos own the left edge", async () => {
    const user = userEvent.setup();
    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Client used for preview" })
    );

    const label = await screen.findByTestId("host-overlay-label-host-a");
    const dot = screen.getByTestId("host-overlay-selected-dot-host-a");
    expect(
      label.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("cycles to the next host when the right arrow is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });

    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={onChange}
        onEditHost={vi.fn()}
      />
    );

    await user.click(screen.getByTestId("host-overlay-next"));
    expect(onChange).toHaveBeenCalledWith("host-b");
  });

  it("wraps the prev arrow from the first host to the last", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });

    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={onChange}
        onEditHost={vi.fn()}
      />
    );

    await user.click(screen.getByTestId("host-overlay-prev"));
    // Sort order pins MCPJam first, so prev from host-a (MCPJam) wraps to
    // host-b (Claude).
    expect(onChange).toHaveBeenCalledWith("host-b");
  });

  it("disables the arrows when there is only one host", () => {
    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />
    );

    expect(screen.getByTestId("host-overlay-prev")).toBeDisabled();
    expect(screen.getByTestId("host-overlay-next")).toBeDisabled();
  });

  it("disables delete on the only host and explains why in a tooltip", async () => {
    const user = userEvent.setup();
    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Client used for preview" })
    );

    const deleteBtn = await screen.findByTestId("host-overlay-delete-host-a");
    expect(deleteBtn).toBeDisabled();
    expect(deleteBtn).toHaveAttribute(
      "title",
      expect.stringContaining("at least one client")
    );
  });

  it("enables delete when more than one host exists", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });

    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Client used for preview" })
    );

    const deleteBtn = await screen.findByTestId("host-overlay-delete-host-a");
    expect(deleteBtn).not.toBeDisabled();
    expect(deleteBtn).not.toHaveAttribute("title");
  });
});
