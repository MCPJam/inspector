import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorToastMessage } from "@/test/utils";
import { ChatboxPublishClientBar } from "../ChatboxPublishClientBar";

const {
  setChatboxServersMock,
  toastMock,
  navigateMock,
  setPreviewedHostIdMock,
  hostListState,
} = vi.hoisted(() => ({
  setChatboxServersMock: vi
    .fn()
    .mockResolvedValue({ attachmentId: "att-row-1" }),
  toastMock: { success: vi.fn(), error: vi.fn() },
  navigateMock: vi.fn(),
  setPreviewedHostIdMock: vi.fn(),
  // Mutable so a test can inject a journeys-owned (standalone) host and assert
  // it's filtered out of the switcher options.
  hostListState: {
    hosts: [
      { hostId: "host-1", name: "MCPJam" },
      { hostId: "host-2", name: "Claude" },
    ] as Array<{ hostId: string; name: string; ownerScope?: unknown }>,
  },
}));

const DEFAULT_HOSTS = [
  { hostId: "host-1", name: "MCPJam" },
  { hostId: "host-2", name: "Claude" },
];

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: (name: string) =>
    name === "chatboxes:setChatboxServers" ? setChatboxServersMock : vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => navigateMock,
  buildHostsPath: (hostId: string) => `/hosts/${hostId}`,
}));

vi.mock("@/lib/chatbox-client-style", () => ({
  resolveHostLogoByDisplayName: () => null,
}));

vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => ["host-1", setPreviewedHostIdMock],
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: hostListState.hosts,
    isLoading: false,
  }),
}));

vi.mock("@/lib/analytics", () => ({
  track: vi.fn(),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [
      {
        _id: "att-1",
        name: "Excalidraw",
        serverIds: ["s1"],
        resolvedServerNames: ["excalidraw"],
        createdAt: 0,
        updatedAt: 0,
      },
      {
        _id: "att-2",
        name: "Drawing + Linear",
        serverIds: ["s1", "s2"],
        resolvedServerNames: ["excalidraw", "linear"],
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    isLoading: false,
  }),
  useProjectServers: () => ({
    servers: [
      { _id: "s1", name: "excalidraw" },
      { _id: "s2", name: "linear" },
    ],
    isLoading: false,
  }),
}));

function renderBar(currentServerIds: string[] = []) {
  return render(
    <ChatboxPublishClientBar
      chatboxId="cb-1"
      projectId="proj-1"
      hostId="host-1"
      hostName="MCPJam"
      isAuthenticated
      currentServerIds={currentServerIds}
    />,
  );
}

describe("ChatboxPublishClientBar", () => {
  afterEach(() => {
    hostListState.hosts = [...DEFAULT_HOSTS];
  });

  it("shows the empty pick state when no servers are picked", () => {
    renderBar([]);
    expect(screen.getByText("No servers picked")).toBeInTheDocument();
  });

  it("shows the matching attachment name when the chatbox set equals a named attachment", () => {
    renderBar(["s1", "s2"]);
    expect(screen.getByText("Drawing + Linear")).toBeInTheDocument();
    expect(screen.getByText("· 2 servers")).toBeInTheDocument();
  });

  it("labels a non-empty set that matches no attachment as a custom pick", () => {
    renderBar(["s2"]);
    expect(screen.getByText("1 server · custom pick")).toBeInTheDocument();
  });

  it("persists the picked attachment's servers through setChatboxServers", async () => {
    const user = userEvent.setup();
    renderBar([]);

    await user.click(screen.getByText("No servers picked"));
    await user.click(await screen.findByText("Excalidraw"));

    expect(setChatboxServersMock).toHaveBeenCalledWith({
      chatboxId: "cb-1",
      selectedServerIds: ["s1"],
    });
    expect(toastMock.success).toHaveBeenCalledWith(
      'Swarm now connects to 1 server via "Excalidraw".',
    );
  });

  it("surfaces a toast error when persisting fails", async () => {
    setChatboxServersMock.mockRejectedValueOnce(new Error("nope"));
    const user = userEvent.setup();
    renderBar([]);

    await user.click(screen.getByText("No servers picked"));
    await user.click(await screen.findByText("Excalidraw"));

    expect(toastMock.error).toHaveBeenCalledWith(
      errorToastMessage("Failed to save servers: nope"),
      { duration: Infinity },
    );
  });

  it("renders a host picker pill for the current host", () => {
    renderBar([]);
    expect(screen.getByTestId("chatbox-host-picker")).toBeInTheDocument();
    expect(screen.getByText("Client")).toBeInTheDocument();
    expect(screen.getByText("MCPJam")).toBeInTheDocument();
  });

  it("switches the previewed host from the picker dropdown", async () => {
    const user = userEvent.setup();
    renderBar([]);

    await user.click(screen.getByTestId("chatbox-host-picker"));
    await user.click(await screen.findByTestId("chatbox-host-option-host-2"));

    expect(setPreviewedHostIdMock).toHaveBeenCalledWith("host-2");
  });

  it("navigates to Connect from the settings control", async () => {
    const user = userEvent.setup();
    renderBar([]);

    await user.click(screen.getByTestId("chatbox-host-edit"));

    expect(navigateMock).toHaveBeenCalledWith("/hosts/host-1");
  });

  it("excludes standalone (Journeys-owned) hosts from the switcher options", async () => {
    // A journeys-owned host has no publish surface — it must not appear as a
    // switch target in the chatbox client picker.
    hostListState.hosts = [
      { hostId: "host-1", name: "MCPJam" },
      { hostId: "host-2", name: "Claude" },
      { hostId: "host-3", name: "Swarm Client", ownerScope: { type: "journeys" } },
    ];
    const user = userEvent.setup();
    renderBar([]);

    await user.click(screen.getByTestId("chatbox-host-picker"));
    // Publishable hosts are offered…
    expect(
      await screen.findByTestId("chatbox-host-option-host-2"),
    ).toBeInTheDocument();
    // …the journeys host is not.
    expect(
      screen.queryByTestId("chatbox-host-option-host-3"),
    ).not.toBeInTheDocument();
  });
});
