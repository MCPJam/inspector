import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { HostCanvasSelector } from "@/components/hosts/redesigned/HostCanvasSelector";
import { track } from "@/lib/analytics";

vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="create-host-dialog" /> : null,
}));

const mockUseHostList = vi.fn();
const mockNavigate = vi.fn();
const mockSetPreviewedHostId = vi.fn();

vi.mock("react-router", () => ({
  useNavigate: () => mockNavigate,
}));

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

vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [null, mockSetPreviewedHostId],
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

describe("HostCanvasSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseHostList.mockReturnValue({ hosts: oneHost, isLoading: false });
  });

  it("shows the active client with its position chip and a labeled Add client button", () => {
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    expect(screen.getByTestId("host-canvas-current")).toHaveTextContent(
      "MCPJam"
    );
    expect(screen.getByTestId("host-canvas-current")).toHaveTextContent(
      "1 / 1"
    );
    const addBtn = screen.getByTestId("host-canvas-add");
    expect(addBtn).toBeVisible();
    expect(addBtn).toHaveTextContent("Add client");
  });

  it("opens the create dialog and tracks when Add client is clicked", async () => {
    const user = userEvent.setup();
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    expect(screen.queryByTestId("create-host-dialog")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("host-canvas-add"));

    expect(screen.getByTestId("create-host-dialog")).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith("connect_host_overlay_add_clicked", {
      location: "host_canvas",
      host_count: 1,
    });
  });

  it("opens the client menu downward, below the top-left pills", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    await user.click(screen.getByTestId("host-canvas-current"));

    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(menu).toHaveAttribute("data-side", "bottom");
    });
  });

  it("keeps the add-client action out of the switcher menu", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    await user.click(screen.getByTestId("host-canvas-current"));
    await screen.findByRole("menu");

    // The only add path is the left-most pill; the menu must not carry a
    // second one (per the #3269 review).
    expect(
      screen.queryByTestId("host-canvas-menu-add")
    ).not.toBeInTheDocument();
  });

  it("navigates to the picked host and updates the preview pointer", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    await user.click(screen.getByTestId("host-canvas-current"));
    await user.click(
      await screen.findByRole("menuitemradio", { name: /Claude/ })
    );

    expect(mockSetPreviewedHostId).toHaveBeenCalledWith("host-b");
    expect(mockNavigate).toHaveBeenCalledWith("/hosts/host-b", {
      replace: true,
    });
    expect(track).toHaveBeenCalledWith(
      "connect_host_overlay_swapped",
      expect.objectContaining({
        location: "host_canvas",
        from: "host-a",
        to: "host-b",
      })
    );
  });

  it("disables delete on the only host and explains why in a tooltip", async () => {
    const user = userEvent.setup();
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    await user.click(screen.getByTestId("host-canvas-current"));

    const deleteBtn = await screen.findByTestId("host-canvas-delete-host-a");
    expect(deleteBtn).toBeDisabled();
    expect(deleteBtn).toHaveAttribute(
      "title",
      expect.stringContaining("at least one client")
    );
  });

  it("enables delete when more than one host exists", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    await user.click(screen.getByTestId("host-canvas-current"));

    const deleteBtn = await screen.findByTestId("host-canvas-delete-host-a");
    expect(deleteBtn).not.toBeDisabled();
    expect(deleteBtn).not.toHaveAttribute("title");
  });
});
