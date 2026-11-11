/**
 * What a user actually sees when Ask MCPJam refuses.
 *
 * The agent is free, so its refusals are about MCPJam's budget and not the
 * reader's credits. Two things must hold at once: the thread prints one plain
 * sentence rather than the JSON body (which reads as a crash), and nothing
 * opens the out-of-credits dialog, which would offer to sell credits that
 * cannot clear the refusal.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { notifyMCPJamLimitError } from "@/lib/mcpjam-limit";

const sessionState = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  autoResumeNotice: null as string | null,
  editRejectedMessage: vi.fn(() => "Debug this failure"),
  submit: vi.fn(),
  onNewChat: vi.fn(),
  messages: [] as UIMessage[],
}));

vi.mock("@/hooks/use-mcpjam-agent-session", () => ({
  useMcpjamAgentSession: () => ({
    get messages() {
      return sessionState.messages;
    },
    get error() {
      return sessionState.error;
    },
    get autoResumeNotice() {
      return sessionState.autoResumeNotice;
    },
    status: "ready",
    model: { id: "agent-model", provider: "mcpjam" },
    hydrating: false,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    requireToolApproval: false,
    setRequireToolApproval: vi.fn(),
    handleToolApprovalResponse: vi.fn(),
    chatSessionId: "agent-refusal-session",
    editRejectedMessage: sessionState.editRejectedMessage,
    submit: sessionState.submit,
  }),
}));

// The transcript isn't under test, and its tool parts need app state.
vi.mock("@/components/chat-v2/thread", () => ({ Thread: () => null }));

import { McpjamAgentThread } from "../McpjamAgentThread";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";

function renderWithError(body: unknown) {
  sessionState.error = new Error(JSON.stringify(body));
  renderThread();
}

function renderThread() {
  render(
    <PreferencesStoreProvider themeMode="dark" themePreset="default">
      <McpjamAgentThread
        sessionId="agent-refusal-session"
        projectId="project-1"
        organizationId="org-1"
        surface="test"
        onNewChat={sessionState.onNewChat}
      />
    </PreferencesStoreProvider>,
  );
}

describe("McpjamAgentThread refusal copy", () => {
  beforeEach(() => {
    useMCPJamLimitDialogStore.setState({ isOpen: false });
    sessionState.error = undefined;
    sessionState.autoResumeNotice = null;
    sessionState.editRejectedMessage.mockClear();
    sessionState.submit.mockClear();
    sessionState.onNewChat.mockClear();
    sessionState.messages = [];
  });

  it("shows one plain line for a spent budget, not the raw body", () => {
    const body = {
      ok: false,
      code: "platform_capacity",
      error: "MCPJam's daily budget for this feature is used up.",
      canTopUp: false,
    };
    renderWithError(body);
    expect(
      screen.getByText(
        "Ask MCPJam has reached today's limit. It resets at 00:00 UTC.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(JSON.stringify(body))).toBeNull();
  });

  it("explains oversized input and restores the rejected prompt for editing", () => {
    sessionState.messages = [{ id: "rejected", role: "user", parts: [] }];
    const body = {
      code: "guest_input_too_large",
      estimatedInputTokens: 37002,
      limit: 32000,
    };
    renderWithError(body);
    expect(
      screen.getByText(
        "This conversation is too large to send. Shorten your message or start a new chat.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(JSON.stringify(body))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    expect(sessionState.editRejectedMessage).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox")).toHaveValue("Debug this failure");
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("keeps the text and offers a new chat once tools ran before the refusal", () => {
    sessionState.messages = [
      {
        id: "request",
        role: "user",
        parts: [{ type: "text", text: "Create a server" }],
      },
      {
        id: "tool-reply",
        role: "assistant",
        parts: [
          {
            type: "tool-ui_create_server",
            toolCallId: "create-server",
            state: "output-available",
            input: {},
            output: { serverId: "created-server" },
          },
        ],
      },
    ];
    renderWithError({ code: "guest_input_too_large" });
    expect(
      screen.getByText(
        "This conversation is too large to continue. Start a new chat to keep going.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
    const composer = screen.getByRole("textbox");
    fireEvent.change(composer, { target: { value: "What already happened?" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(sessionState.submit).not.toHaveBeenCalled();
    expect(composer).toHaveValue("What already happened?");
    fireEvent.click(screen.getByRole("button", { name: "Start new chat" }));
    expect(sessionState.onNewChat).toHaveBeenCalledOnce();
  });

  it("still sends a replacement when no tool ran before the refusal", () => {
    sessionState.messages = [{ id: "rejected", role: "user", parts: [] }];
    renderWithError({ code: "guest_input_too_large" });
    const composer = screen.getByRole("textbox");
    fireEvent.change(composer, { target: { value: "Shorter" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(sessionState.submit).toHaveBeenCalledWith("Shorter");
    expect(composer).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Start new chat" })).toBeNull();
  });

  it("shows the same line for the per-user turn cap", () => {
    renderWithError({ ok: false, code: "agent_turn_limit", gatedBy: "user" });
    expect(
      screen.getByText(
        "Ask MCPJam has reached today's limit. It resets at 00:00 UTC.",
      ),
    ).toBeTruthy();
  });

  it("calls a refused claim temporary, because no reset lifts it", () => {
    renderWithError({ ok: false, code: "agent_billing_rejected" });
    expect(
      screen.getByText("Ask MCPJam is temporarily unavailable."),
    ).toBeTruthy();
  });

  it("never opens the out-of-credits dialog for any of them", () => {
    for (const code of [
      "platform_capacity",
      "agent_turn_limit",
      "agent_billing_rejected",
    ]) {
      expect(notifyMCPJamLimitError({ code })).toBe(false);
    }
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });

  it("shows the loop guard's sentence, not its 409 envelope", () => {
    const body = {
      code: "AGENT_STEP_LIMIT",
      message:
        "This reply reached its step limit, so it was stopped. Send a message to continue.",
      details: { reason: "step_limit", steps: 16, maxSteps: 16 },
    };
    renderWithError(body);
    expect(
      screen.getByText(
        "This reply reached its step limit, so it was stopped. Send a message to continue.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(JSON.stringify(body))).toBeNull();
  });

  it("says why a turn stopped short of resuming, in one line", () => {
    sessionState.autoResumeNotice =
      "The reply was cut off. Send a message to continue.";
    renderThread();
    expect(
      screen.getByText("The reply was cut off. Send a message to continue."),
    ).toBeTruthy();
  });

  it("lets an error speak for itself instead of stacking the notice on it", () => {
    sessionState.autoResumeNotice =
      "The reply was cut off. Send a message to continue.";
    renderWithError({ ok: false, code: "agent_billing_rejected" });
    expect(
      screen.queryByText("The reply was cut off. Send a message to continue."),
    ).toBeNull();
  });
});
