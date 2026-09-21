import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HostCanvasSelector } from "@/components/hosts/redesigned/HostCanvasSelector";
import { track } from "@/lib/analytics";

vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="create-host-dialog" /> : null,
}));

const mockDeleteHost = vi.fn().mockResolvedValue(undefined);
const mockUseHostList = vi.fn();
const mockNavigate = vi.fn();
const mockSetPreviewedHostId = vi.fn();

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
}));

// `useAppNavigate`, not react-router's `useNavigate`: app navigation goes
// through the scoped helper now, which carries the active project into
// project-owned paths (`/p/<projectId>/hosts/<id>`). The rest of
// `app-navigation` is the real module — these suites assert against its
// path builders.
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  useAppNavigate: () => mockNavigate,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: (...args: unknown[]) => mockUseHostList(...args),
  useHostMutations: () => ({
    createHost: vi.fn(),
    updateHost: vi.fn(),
    deleteHost: mockDeleteHost,
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
    selector: (state: { themeMode: "light" | "dark" }) => unknown,
  ) => selector({ themeMode: "light" }),
}));

vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
      "MCPJam",
    );
    expect(screen.getByTestId("host-canvas-current")).toHaveTextContent(
      "1 / 1",
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

  it("opens the client menu downward, below the nav-row pills", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    await user.click(screen.getByTestId("host-canvas-current"));

    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(menu).toHaveAttribute("data-side", "bottom");
    });
  });

  it("offers Add clients in the switcher menu and opens the New Client modal", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    await user.click(screen.getByTestId("host-canvas-current"));
    await user.click(await screen.findByTestId("host-canvas-menu-add"));

    expect(screen.getByTestId("create-host-dialog")).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith("connect_host_overlay_add_clicked", {
      location: "host_canvas",
      host_count: 2,
    });
  });

  it("falls back to the same generic MCP mark as the header picker", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({
      hosts: [{ ...oneHost[0], name: "Acme Internal Bot" }],
      isLoading: false,
    });
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    await user.click(screen.getByTestId("host-canvas-current"));

    // Pins the concrete value, not just "some logo". This picker and the
    // retired header bar used to disagree here — one drew an empty circle —
    // so the assertion is what catches it going back to its own resolver
    // instead of `resolveHostLogoByName`.
    const row = await screen.findByRole("menuitemradio", {
      name: /Acme Internal Bot/,
    });
    expect(row.querySelector("img")).toHaveAttribute("src", "/mcp.svg");
  });

  it("marks the active client with a single primary-colored dot", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    await user.click(screen.getByTestId("host-canvas-current"));

    // Only the active host gets a dot, so the design-system's built-in
    // left-gutter indicator must be gone — two dots would read as two
    // selections, and it would also collide with the row logo.
    const dots = await screen.findAllByTestId(/^host-canvas-selected-dot-/);
    expect(dots).toHaveLength(1);
    expect(dots[0]).toHaveAttribute(
      "data-testid",
      "host-canvas-selected-dot-host-a",
    );
    expect(dots[0]).toHaveClass("bg-primary");

    const row = screen.getByRole("menuitemradio", { name: /MCPJam/ });
    expect(row.querySelector("span.absolute")).toBeNull();
  });

  it("places the active dot after the client name so the logo owns the left edge", async () => {
    const user = userEvent.setup();
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    await user.click(screen.getByTestId("host-canvas-current"));

    const label = await screen.findByTestId("host-canvas-label-host-a");
    const dot = screen.getByTestId("host-canvas-selected-dot-host-a");
    expect(
      label.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("navigates to the picked host and updates the preview pointer", async () => {
    const user = userEvent.setup();
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    await user.click(screen.getByTestId("host-canvas-current"));
    await user.click(
      await screen.findByRole("menuitemradio", { name: /Claude/ }),
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
      }),
    );
  });

  it("hides the add pill on Servers but still opens New Client from the switcher", async () => {
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });
    const user = userEvent.setup();
    render(
      <HostCanvasSelector
        projectId="proj-1"
        activeHostId="host-a"
        showAddClient={false}
      />,
    );
    expect(screen.queryByTestId("host-canvas-add")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("host-canvas-quick-add"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("host-canvas-current")).toBeVisible();
    await user.click(screen.getByTestId("host-canvas-current"));
    await user.click(await screen.findByTestId("host-canvas-menu-add"));
    expect(screen.getByTestId("create-host-dialog")).toBeInTheDocument();
  });

  it("switches clients on Servers without navigating away", async () => {
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });
    const user = userEvent.setup();
    render(
      <HostCanvasSelector
        projectId="proj-1"
        activeHostId="host-a"
        navigateOnSwitch={false}
      />,
    );
    await user.click(screen.getByTestId("host-canvas-current"));
    await user.click(
      await screen.findByRole("menuitemradio", { name: /Claude/ }),
    );
    expect(mockSetPreviewedHostId).toHaveBeenCalledWith("host-b");
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("selects a surviving client after deleting the active client on Servers", async () => {
    mockUseHostList.mockReturnValue({ hosts: twoHosts, isLoading: false });
    const user = userEvent.setup();
    render(
      <HostCanvasSelector
        projectId="proj-1"
        activeHostId="host-a"
        navigateOnSwitch={false}
      />,
    );
    await user.click(screen.getByTestId("host-canvas-current"));
    fireEvent.click(await screen.findByTestId("host-canvas-delete-host-a"));
    expect(mockDeleteHost).toHaveBeenCalledWith({ hostId: "host-a" });
    await waitFor(() =>
      expect(mockSetPreviewedHostId).toHaveBeenCalledWith("host-b"),
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("disables delete on the only host and explains why in a tooltip", async () => {
    const user = userEvent.setup();
    render(<HostCanvasSelector projectId="proj-1" activeHostId="host-a" />);

    await user.click(screen.getByTestId("host-canvas-current"));

    const deleteBtn = await screen.findByTestId("host-canvas-delete-host-a");
    expect(deleteBtn).toBeDisabled();
    expect(deleteBtn).toHaveAttribute(
      "title",
      expect.stringContaining("at least one client"),
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
