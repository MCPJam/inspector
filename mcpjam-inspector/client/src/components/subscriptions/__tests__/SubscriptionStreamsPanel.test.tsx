import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type {
  SubscriptionBridgeEvent,
  SubscriptionServerStateView,
  SubscriptionStreamView,
} from "@/shared/subscription-bridge.js";
import { SubscriptionStreamsPanel } from "../SubscriptionStreamsPanel";

/**
 * The panel is the debugger's window onto the LOCAL coordinator: it must show
 * the lifecycle, the requested-vs-acknowledged difference and the close reason,
 * and it must offer the era-correct control — a desired filter on the modern
 * era (which reopens the stream) and the preserved per-URI Subscribe /
 * Unsubscribe buttons on the legacy era.
 */

const state = vi.hoisted(() => ({
  fetchState: vi.fn(),
  setDesired: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/apis/mcp-subscriptions-api", () => ({
  fetchSubscriptionState: state.fetchState,
  setDesiredSubscriptionInterests: state.setDesired,
  cancelSubscriptionStream: state.cancel,
}));

vi.mock("@/lib/session-token", () => ({
  addTokenToUrl: (url: string) => url,
}));

let sseInstances: FakeEventSource[] = [];

class FakeEventSource {
  onmessage: ((ev: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    sseInstances.push(this);
  }
  emit(event: SubscriptionBridgeEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  close() {
    this.closed = true;
  }
}

function stream(
  overrides: Partial<SubscriptionStreamView> = {},
): SubscriptionStreamView {
  return {
    localId: "local-1",
    era: "modern",
    mcpSubscriptionId: "sub-1",
    idBinding: "reported",
    requestedFilter: { toolsListChanged: true, promptsListChanged: true },
    acknowledgedFilter: { toolsListChanged: true },
    rejectedInterests: [
      { interest: "prompts-list-changed", reason: "not-acknowledged-by-server" },
    ],
    status: "active",
    openedAt: 1,
    acknowledgedAt: 2,
    reconnectAttempt: 0,
    ...overrides,
  };
}

function serverState(
  overrides: Partial<SubscriptionServerStateView> = {},
): SubscriptionServerStateView {
  return {
    serverId: "srv",
    era: "modern",
    supportsListen: true,
    supportsTaskDeclaredListen: false,
    desired: { toolsListChanged: true, promptsListChanged: true },
    streams: [stream()],
    notifications: [],
    rejectedNotifications: [],
    ...overrides,
  };
}

beforeEach(() => {
  sseInstances = [];
  Object.assign(globalThis, { EventSource: FakeEventSource });
  state.fetchState.mockReset().mockResolvedValue(serverState());
  state.setDesired.mockReset().mockResolvedValue(serverState());
  state.cancel.mockReset().mockResolvedValue(serverState());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SubscriptionStreamsPanel", () => {
  it("surfaces the coordinator's stream lifecycle, ids and close reason", async () => {
    state.fetchState.mockResolvedValue(
      serverState({
        streams: [
          stream({
            status: "remote-closed",
            closeReason: "remote",
            closedAt: 5,
            reconnectAttempt: 1,
          }),
        ],
      }),
    );
    render(<SubscriptionStreamsPanel serverId="srv" />);

    await screen.findByText("Connection lost (remote close)");
    expect(screen.getByText(/sub-1/)).toBeTruthy();
    expect(screen.getByText(/\(reported\)/)).toBeTruthy();
    expect(screen.getByText(/Close reason: remote/)).toBeTruthy();
    expect(screen.getByText(/Re-listen attempt: 1/)).toBeTruthy();
  });

  it("shows the requested filter next to the acknowledged one and the refusal", async () => {
    render(<SubscriptionStreamsPanel serverId="srv" />);

    await screen.findByText(
      "Requested: tools/list_changed, prompts/list_changed",
    );
    expect(screen.getByText("Acknowledged: tools/list_changed")).toBeTruthy();
    expect(
      screen.getByText(/Not honored: prompts-list-changed \(not acknowledged\)/),
    ).toBeTruthy();
  });

  it("modern era: editing the desired filter posts new interests (stream reopens)", async () => {
    render(<SubscriptionStreamsPanel serverId="srv" />);
    await screen.findByLabelText("resources/list_changed");

    fireEvent.click(screen.getByLabelText("resources/list_changed"));

    await waitFor(() => expect(state.setDesired).toHaveBeenCalledTimes(1));
    expect(state.setDesired).toHaveBeenCalledWith("srv", {
      toolsListChanged: true,
      promptsListChanged: true,
      resourcesListChanged: true,
    });
    // No per-URI verbs on the modern era.
    expect(screen.queryByRole("button", { name: "Subscribe" })).toBeNull();
  });

  it("legacy era: keeps the per-URI Subscribe / Unsubscribe buttons", async () => {
    state.fetchState.mockResolvedValue(
      serverState({
        era: "legacy",
        supportsListen: false,
        desired: { resourceUris: ["file:///b.txt"] },
        streams: [
          stream({
            era: "legacy",
            mcpSubscriptionId: undefined,
            idBinding: undefined,
            requestedFilter: { resourceSubscriptions: ["file:///b.txt"] },
            acknowledgedFilter: { resourceSubscriptions: ["file:///b.txt"] },
            rejectedInterests: [],
          }),
        ],
      }),
    );
    render(
      <SubscriptionStreamsPanel
        serverId="srv"
        resourceUris={["file:///a.txt", "file:///b.txt"]}
      />,
    );

    const subscribe = await screen.findByRole("button", { name: "Subscribe" });
    const unsubscribe = screen.getByRole("button", { name: "Unsubscribe" });
    expect(subscribe).toBeTruthy();
    expect(unsubscribe).toBeTruthy();
    expect(screen.queryByLabelText("Watch file:///a.txt")).toBeNull();

    fireEvent.click(subscribe);
    await waitFor(() => expect(state.setDesired).toHaveBeenCalledTimes(1));
    expect(state.setDesired).toHaveBeenCalledWith("srv", {
      resourceUris: ["file:///b.txt", "file:///a.txt"],
    });
  });

  it("History distinguishes a graceful close from a remote loss", async () => {
    render(<SubscriptionStreamsPanel serverId="srv" />);
    await screen.findByText(/Server acknowledged tools\/list_changed/);
    const es = sseInstances[0];

    es.emit({
      type: "subscription_stream",
      serverId: "srv",
      era: "modern",
      stream: stream({
        status: "graceful-closed",
        closeReason: "graceful",
        closedAt: 6,
      }),
    });
    es.emit({
      type: "subscription_stream",
      serverId: "srv",
      era: "modern",
      stream: stream({
        localId: "local-2",
        mcpSubscriptionId: "sub-2",
        status: "remote-closed",
        closeReason: "remote",
        closedAt: 7,
      }),
    });

    await waitFor(() =>
      expect(screen.getByTestId("history-closed-graceful")).toBeTruthy(),
    );
    expect(screen.getByTestId("history-closed-remote")).toBeTruthy();
    expect(
      screen.getByTestId("history-closed-graceful").textContent,
    ).toContain("Closed by server (graceful)");
    expect(screen.getByTestId("history-closed-remote").textContent).toContain(
      "Connection lost (remote close)",
    );
  });

  it("History shows a rejected notification rather than dropping it", async () => {
    render(<SubscriptionStreamsPanel serverId="srv" />);
    await screen.findByText(/Server acknowledged tools\/list_changed/);

    sseInstances[0].emit({
      type: "subscription_rejected",
      serverId: "srv",
      rejection: {
        method: "notifications/prompts/list_changed",
        subscriptionId: "sub-1",
        localSubscriptionId: "local-1",
        reason: "unrequested-type",
        at: 9,
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId("history-rejected").textContent).toContain(
        "Rejected notifications/prompts/list_changed — unrequested-type",
      ),
    );
  });
});
