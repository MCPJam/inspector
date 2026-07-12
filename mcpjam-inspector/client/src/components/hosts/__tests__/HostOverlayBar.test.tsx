import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { HostOverlayBar } from "@/components/hosts/HostOverlayBar";
import { track } from "@/lib/analytics";

vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="create-host-dialog" /> : null,
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

  it("shows an always-visible add button without opening the dropdown", () => {
    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />
    );

    const addBtn = screen.getByTestId("host-overlay-add");
    expect(addBtn).toBeVisible();
    expect(addBtn).not.toBeDisabled();
    expect(addBtn).toHaveAccessibleName("Add client");
  });

  it("opens the create dialog and tracks when the add button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <HostOverlayBar
        projectId="proj-1"
        previewedHostId="host-a"
        onChangePreviewedHostId={vi.fn()}
        onEditHost={vi.fn()}
      />
    );

    expect(screen.queryByTestId("create-host-dialog")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("host-overlay-add"));

    expect(screen.getByTestId("create-host-dialog")).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith("connect_host_overlay_add_clicked", {
      location: "chatbox_overlay",
      host_count: 1,
    });
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
