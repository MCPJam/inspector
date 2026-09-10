import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  sessionId: "chat-1" as string | null,
  setEngine: vi.fn(),
  newChat: vi.fn(async () => true),
  revoke: vi.fn(),
}));
vi.mock("@/hooks/useBrowserEngine", () => ({
  useBrowserEngine: () => ({
    selectedEngine: "local",
    toggleVisible: true,
    resolved: true,
    localAvailable: true,
    consent: { granted: true, revoke: state.revoke },
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
    select({ reasons: {} }),
}));
import { BrowserRuntimeControls } from "../BrowserRuntimeControls";
beforeEach(() => {
  vi.clearAllMocks();
  state.sessionId = "chat-1";
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

it("keeps runtime controls in the compact options menu", async () => {
  render(<BrowserRuntimeControls projectId="p" compact />);
  expect(screen.queryByLabelText("Browser location")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Browser options" }));
  expect(await screen.findByLabelText("Browser location")).toBeVisible();
  fireEvent.click(screen.getByText("Revoke Browser"));
  expect(state.revoke).toHaveBeenCalledOnce();
});
