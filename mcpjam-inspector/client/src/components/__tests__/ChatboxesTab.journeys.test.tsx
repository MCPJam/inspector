import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatboxesTab } from "../ChatboxesTab";

/**
 * Guards the standalone-host must-fix: a Journeys-owned host has NO publish
 * surface, so opening it as a test detail must (a) never back-mint a chatbox
 * and (b) render the "managed by Swarms" notice.
 */
const {
  ensureMock,
  navigateMock,
  hostState,
  chatboxState,
  searchParamsState,
} = vi.hoisted(() => ({
  ensureMock: vi.fn().mockResolvedValue(undefined),
  navigateMock: vi.fn(),
  hostState: {
    host: null as null | {
      hostId: string;
      name: string;
      ownerScope?: { type: string } | null;
    },
    isLoading: false,
  },
  chatboxState: { chatbox: null as unknown, isLoading: false },
  searchParamsState: { host: "host-journeys" as string | null },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: (name: string) =>
    name === "chatboxes:ensureChatboxForHost" ? ensureMock : vi.fn(),
}));

vi.mock("react-router", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: "/user-testing" }),
  useSearchParams: () => {
    const params = new URLSearchParams();
    if (searchParamsState.host) params.set("host", searchParamsState.host);
    return [params, vi.fn()];
  },
}));

vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => ["host-journeys", vi.fn()],
}));

vi.mock("@/hooks/useClients", () => ({
  useHost: () => hostState,
  useHostList: () => ({ hosts: [], isLoading: false }),
}));

vi.mock("@/hooks/useChatboxes", () => ({
  useChatboxByHostId: () => chatboxState,
  useChatboxList: () => ({ chatboxes: [], isLoading: false }),
  useChatboxMutations: () => ({ deleteChatbox: vi.fn() }),
}));

vi.mock("@/hooks/useUsageInsights", () => ({
  useUsageInsights: () => ({
    threads: undefined,
    breakdown: undefined,
    rebuild: vi.fn(),
  }),
}));

vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));

vi.mock("@/components/chatboxes/ChatboxPublishClientBar", () => ({
  ChatboxHostPickerPill: () => <div data-testid="chatbox-host-picker" />,
  ChatboxPublishClientBar: () => <div data-testid="chatbox-publish-bar" />,
}));

vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderTab() {
  return render(<ChatboxesTab projectId="proj-1" isAuthenticated />);
}

describe("ChatboxesTab — Journeys-owned (standalone) host", () => {
  afterEach(() => {
    ensureMock.mockClear();
    navigateMock.mockClear();
    hostState.host = null;
    hostState.isLoading = false;
    chatboxState.chatbox = null;
    chatboxState.isLoading = false;
    searchParamsState.host = "host-journeys";
  });

  it("does NOT back-mint a chatbox and shows the notice", async () => {
    hostState.host = {
      hostId: "host-journeys",
      name: "Swarm Client",
      ownerScope: { type: "journeys" },
    };
    chatboxState.chatbox = null;

    renderTab();

    expect(await screen.findByText(/Managed by Swarms/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(ensureMock).not.toHaveBeenCalled();
    });
  });

  it("DOES back-mint for a chatbox-less untagged host (control)", async () => {
    hostState.host = {
      hostId: "host-journeys",
      name: "Legacy Client",
      ownerScope: null,
    };
    chatboxState.chatbox = null;

    renderTab();

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledWith({ hostId: "host-journeys" });
    });
    expect(screen.queryByText(/Managed by Swarms/i)).not.toBeInTheDocument();
  });

  it("waits for the host query to load before deciding (no ensure while loading)", async () => {
    hostState.host = null;
    hostState.isLoading = true;
    chatboxState.chatbox = null;
    chatboxState.isLoading = false;

    renderTab();

    await waitFor(() => {
      expect(ensureMock).not.toHaveBeenCalled();
    });
    expect(screen.queryByText(/Managed by Swarms/i)).not.toBeInTheDocument();
  });

  it("a RESOLVED-missing host renders the not-found state and never provisions", async () => {
    hostState.host = null;
    hostState.isLoading = false;
    chatboxState.chatbox = null;
    chatboxState.isLoading = false;

    renderTab();

    expect(await screen.findByText(/Client not found/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(ensureMock).not.toHaveBeenCalled();
    });
  });
});
