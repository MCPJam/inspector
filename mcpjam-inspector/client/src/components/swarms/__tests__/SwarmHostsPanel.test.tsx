import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwarmHostsPanel } from "../SwarmHostsPanel";

const {
  hostListState,
  updateHostMock,
  deleteHostMock,
  navigateMock,
  createDialogState,
  hostDetail,
} = vi.hoisted(() => ({
  hostListState: {
    hosts: [] as Array<{
      hostId: string;
      name: string;
      modelId?: string;
      serverCount?: number;
      hasComputer?: boolean;
      ownerScope?: { type: string } | null;
    }>,
  },
  updateHostMock: vi.fn().mockResolvedValue({ hostId: "h", hostConfigId: "c" }),
  deleteHostMock: vi.fn().mockResolvedValue(undefined),
  navigateMock: vi.fn(),
  createDialogState: { owner: undefined as string | undefined, isOpen: false },
  hostDetail: {
    host: {
      hostId: "host-journeys",
      name: "Swarm Client",
      config: {
        modelId: "anthropic/claude-haiku-4.5",
        serverIds: ["old-server"],
        optionalServerIds: ["old-optional"],
      },
    },
  },
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: hostListState.hosts, isLoading: false }),
  useHost: () => hostDetail,
  useHostMutations: () => ({
    createHost: vi.fn(),
    updateHost: updateHostMock,
    deleteHost: deleteHostMock,
    duplicateHost: vi.fn(),
  }),
}));

vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => navigateMock,
  buildHostsPath: (hostId: string) => `/hosts/${hostId}`,
}));

vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// hostConfigDtoToInput just carries the config forward; return a known base so
// the apply test can prove serverIds/optionalServerIds are REPLACED.
vi.mock("@/lib/client-config-v2", () => ({
  hostConfigDtoToInput: (dto: {
    modelId: string;
    serverIds: string[];
    optionalServerIds: string[];
  }) => ({
    modelId: dto.modelId,
    systemPrompt: "sys",
    serverIds: dto.serverIds,
    optionalServerIds: dto.optionalServerIds,
  }),
}));

// Stub the picker so a click fires onChange with a known server group.
const GROUP = {
  _id: "grp-1",
  name: "Excalidraw",
  serverIds: ["s1", "s2"],
  resolvedServerNames: ["excalidraw", "other"],
};
vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: ({
    onChange,
    disabled,
  }: {
    onChange: (id: string, g: typeof GROUP) => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      data-testid="apply-group"
      disabled={disabled}
      onClick={() => onChange(GROUP._id, GROUP)}
    >
      apply group
    </button>
  ),
}));

// Stub the create dialog; capture the owner prop it was handed.
vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: ({
    isOpen,
    owner,
    onCreated,
  }: {
    isOpen: boolean;
    owner?: string;
    onCreated: (hostId: string) => void;
  }) => {
    createDialogState.owner = owner;
    createDialogState.isOpen = isOpen;
    return isOpen ? (
      <button
        type="button"
        data-testid="confirm-create"
        onClick={() => onCreated("new-host")}
      >
        create
      </button>
    ) : null;
  },
}));

function renderPanel(canManage: boolean) {
  return render(
    <SwarmHostsPanel
      projectId="proj-1"
      isAuthenticated
      canManage={canManage}
    />,
  );
}

describe("SwarmHostsPanel", () => {
  afterEach(() => {
    hostListState.hosts = [];
    updateHostMock.mockClear();
    deleteHostMock.mockClear();
    navigateMock.mockClear();
    createDialogState.owner = undefined;
    createDialogState.isOpen = false;
  });

  it("lists only journeys-owned + untagged clients (hides chatbox/suite-owned)", () => {
    hostListState.hosts = [
      { hostId: "h1", name: "Swarm One", ownerScope: { type: "journeys" } },
      { hostId: "h2", name: "Untagged Two", ownerScope: null },
      { hostId: "h3", name: "Chatbox Three", ownerScope: { type: "chatbox" } },
      { hostId: "h4", name: "Suite Four", ownerScope: { type: "suite" } },
    ];
    renderPanel(true);

    expect(screen.getByText("Swarm One")).toBeInTheDocument();
    expect(screen.getByText("Untagged Two")).toBeInTheDocument();
    expect(screen.queryByText("Chatbox Three")).not.toBeInTheDocument();
    expect(screen.queryByText("Suite Four")).not.toBeInTheDocument();
  });

  it("renders config chips (model · servers · computer)", () => {
    hostListState.hosts = [
      {
        hostId: "h1",
        name: "Swarm One",
        modelId: "anthropic/claude-haiku-4.5",
        serverCount: 2,
        hasComputer: true,
        ownerScope: { type: "journeys" },
      },
    ];
    renderPanel(true);
    expect(
      screen.getByText("anthropic/claude-haiku-4.5"),
    ).toBeInTheDocument();
    expect(screen.getByText("2 servers")).toBeInTheDocument();
    expect(screen.getByText("computer")).toBeInTheDocument();
  });

  it("HIDES management affordances for a non-admin (member)", () => {
    hostListState.hosts = [
      { hostId: "h1", name: "Swarm One", ownerScope: { type: "journeys" } },
    ];
    renderPanel(false);
    expect(
      screen.queryByRole("button", { name: /new client/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("apply-group")).not.toBeInTheDocument();
  });

  it("SHOWS management affordances for an admin", () => {
    hostListState.hosts = [
      { hostId: "h1", name: "Swarm One", ownerScope: { type: "journeys" } },
    ];
    renderPanel(true);
    expect(
      screen.getByRole("button", { name: /new client/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("apply-group")).toBeInTheDocument();
  });

  it("New client opens the create dialog with owner='journeys'", async () => {
    hostListState.hosts = [
      { hostId: "h1", name: "Swarm One", ownerScope: { type: "journeys" } },
    ];
    const user = userEvent.setup();
    renderPanel(true);
    await user.click(screen.getByRole("button", { name: /new client/i }));
    await waitFor(() => {
      expect(createDialogState.isOpen).toBe(true);
    });
    expect(createDialogState.owner).toBe("journeys");
  });

  it("applying a server group calls updateHost with servers REPLACED (never setChatboxServers)", async () => {
    hostListState.hosts = [
      {
        hostId: "host-journeys",
        name: "Swarm Client",
        ownerScope: { type: "journeys" },
      },
    ];
    const user = userEvent.setup();
    renderPanel(true);

    await user.click(screen.getByTestId("apply-group"));

    await waitFor(() => {
      expect(updateHostMock).toHaveBeenCalledTimes(1);
    });
    expect(updateHostMock).toHaveBeenCalledWith({
      hostId: "host-journeys",
      input: {
        modelId: "anthropic/claude-haiku-4.5",
        systemPrompt: "sys",
        // group's servers replace the old set; optional cleared.
        serverIds: ["s1", "s2"],
        optionalServerIds: [],
      },
    });
  });
});
