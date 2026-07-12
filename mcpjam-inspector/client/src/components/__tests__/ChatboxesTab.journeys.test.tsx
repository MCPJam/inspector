import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatboxesTab } from "../ChatboxesTab";

/**
 * Guards the standalone-host must-fix: a Journeys-owned host has NO publish
 * surface, so the Chatbox surface must (a) never back-mint a chatbox for it
 * and (b) render the "managed by Swarms" notice while keeping the client
 * picker visible so the user can switch to a publishable client.
 */
const { ensureMock, navigateMock, hostState, chatboxState } = vi.hoisted(
  () => ({
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
  }),
);

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: (name: string) =>
    name === "chatboxes:ensureChatboxForHost" ? ensureMock : vi.fn(),
}));

vi.mock("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => ["host-journeys", vi.fn()],
}));

vi.mock("@/hooks/useClients", () => ({
  useHost: () => hostState,
}));

vi.mock("@/hooks/useChatboxes", () => ({
  useChatboxByHostId: () => chatboxState,
}));

// Stub the picker so we don't pull its whole dependency tree; the real one
// renders this same testid.
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
  });

  it("does NOT back-mint a chatbox and shows the notice + picker", async () => {
    hostState.host = {
      hostId: "host-journeys",
      name: "Swarm Client",
      ownerScope: { type: "journeys" },
    };
    chatboxState.chatbox = null; // journeys host has no chatbox

    renderTab();

    expect(await screen.findByText(/Managed by Swarms/i)).toBeInTheDocument();
    // Picker stays visible so the user can switch to a publishable client.
    expect(screen.getByTestId("chatbox-host-picker")).toBeInTheDocument();
    // Critically: the auto-ensure mutation is never fired for a journeys host.
    await waitFor(() => {
      expect(ensureMock).not.toHaveBeenCalled();
    });
  });

  it("DOES back-mint for a chatbox-less untagged host (control)", async () => {
    hostState.host = {
      hostId: "host-journeys",
      name: "Legacy Client",
      ownerScope: null, // untagged → publishable → legacy backfill applies
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
    hostState.isLoading = true; // host still loading
    chatboxState.chatbox = null;
    chatboxState.isLoading = false;

    renderTab();

    // Loading state — no decision, no mint.
    await waitFor(() => {
      expect(ensureMock).not.toHaveBeenCalled();
    });
    expect(screen.queryByText(/Managed by Swarms/i)).not.toBeInTheDocument();
  });

  it("a RESOLVED-missing host renders the not-found state and never provisions", async () => {
    // Host query finished and returned null (deleted / not visible) —
    // provisioning would just fail the mutation and strand the spinner.
    hostState.host = null;
    hostState.isLoading = false;
    chatboxState.chatbox = null;
    chatboxState.isLoading = false;

    renderTab();

    expect(await screen.findByText(/Client not found/i)).toBeInTheDocument();
    // Recoverable: the picker stays visible to select another client.
    expect(screen.getByTestId("chatbox-host-picker")).toBeInTheDocument();
    await waitFor(() => {
      expect(ensureMock).not.toHaveBeenCalled();
    });
  });
});
