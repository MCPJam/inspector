import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  sessionId: "chat-1" as string | null,
  setEngine: vi.fn(),
  newChat: vi.fn(async () => true),
  revoke: vi.fn(),
  granted: true,
  reason: null as string | null,
}));
vi.mock("@/hooks/useBrowserEngine", () => ({
  useBrowserEngine: () => ({
    selectedEngine: "local",
    toggleVisible: true,
    resolved: true,
    localAvailable: true,
    consent: { granted: state.granted, revoke: state.revoke },
    setEngine: state.setEngine,
  }),
}));
vi.mock("@/components/playground/playground-chat-history-bridge", () => ({
  usePlaygroundChatHistoryBridge: () => ({
    onNewChat: state.newChat,
    isStreaming: false,
  }),
}));
vi.mock("@/stores/active-chat-session-store", () => ({
  useActiveChatSessionStore: (select: (s: unknown) => unknown) =>
    select({ sessionId: state.sessionId }),
}));
vi.mock("@/stores/browser-readiness-store", () => ({
  useBrowserReadinessStore: (select: (s: unknown) => unknown) =>
    select({ reasons: state.reason ? { "p:chat-1": state.reason } : {} }),
}));
import { BrowserRuntimeControls } from "../BrowserRuntimeControls";
beforeEach(() => {
  vi.clearAllMocks();
  state.sessionId = "chat-1";
  state.granted = true;
  state.reason = null;
  state.newChat.mockResolvedValue(true);
});
it("changes a bound location only after a new chat succeeds", async () => {
  render(<BrowserRuntimeControls projectId="p" />);
  fireEvent.change(screen.getByLabelText("Browser location"), {
    target: { value: "cloud" },
  });
  expect(state.setEngine).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Start new chat"));
  await waitFor(() => expect(state.setEngine).toHaveBeenCalledWith("cloud"));
});
it("preserves location when new-chat confirmation is cancelled", async () => {
  state.newChat.mockResolvedValue(false);
  render(<BrowserRuntimeControls projectId="p" />);
  fireEvent.change(screen.getByLabelText("Browser location"), {
    target: { value: "cloud" },
  });
  fireEvent.click(screen.getByText("Start new chat"));
  await waitFor(() => expect(state.newChat).toHaveBeenCalled());
  expect(state.setEngine).not.toHaveBeenCalled();
});
it("revokes only through the Browser permission controller", () => {
  render(<BrowserRuntimeControls projectId="p" />);
  fireEvent.click(screen.getByText("Revoke Browser"));
  expect(state.revoke).toHaveBeenCalledOnce();
});

it("shows an actionable permission message and clears it after permission is granted", () => {
  state.granted = false;
  state.reason =
    "browser_consent_required: Allow Browser in the Browser panel.";
  const { rerender } = render(<BrowserRuntimeControls projectId="p" />);
  expect(
    screen.getByText("Allow Browser below, then retry your request."),
  ).toBeTruthy();
  expect(screen.queryByText(/browser_consent_required/)).toBeNull();
  state.granted = true;
  rerender(<BrowserRuntimeControls projectId="p" />);
  expect(
    screen.queryByText("Allow Browser below, then retry your request."),
  ).toBeNull();
});
