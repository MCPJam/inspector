import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatboxPublishClientBar } from "../ChatboxPublishClientBar";

const { setChatboxServersMock, toastMock } = vi.hoisted(() => ({
  setChatboxServersMock: vi
    .fn()
    .mockResolvedValue({ attachmentId: "att-row-1" }),
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: (name: string) =>
    name === "chatboxes:setChatboxServers" ? setChatboxServersMock : vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => vi.fn(),
  buildHostsPath: (hostId: string) => `/hosts/${hostId}`,
}));

vi.mock("@/lib/chatbox-client-style", () => ({
  resolveHostLogoByDisplayName: () => null,
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
      "Failed to save servers: nope",
    );
  });

  it("still renders the labeled host pill that links to Connect", () => {
    renderBar([]);
    expect(screen.getByText("Host")).toBeInTheDocument();
    expect(screen.getByText("MCPJam")).toBeInTheDocument();
  });
});
