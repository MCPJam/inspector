/**
 * What a user actually sees when Ask MCPJam refuses.
 *
 * The agent is free, so its refusals are about MCPJam's budget and not the
 * reader's credits. Two things must hold at once: the thread prints one plain
 * sentence rather than the JSON body (which reads as a crash), and nothing
 * opens the out-of-credits dialog, which would offer to sell credits that
 * cannot clear the refusal.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { notifyMCPJamLimitError } from "@/lib/mcpjam-limit";

const sessionState = vi.hoisted(() => ({
  error: undefined as Error | undefined,
}));

vi.mock("@/hooks/use-mcpjam-agent-session", () => ({
  useMcpjamAgentSession: () => ({
    messages: [],
    get error() {
      return sessionState.error;
    },
    status: "ready",
    model: undefined,
    hydrating: false,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    requireToolApproval: false,
    setRequireToolApproval: vi.fn(),
    handleToolApprovalResponse: vi.fn(),
    chatSessionId: "agent-refusal-session",
  }),
}));

import { McpjamAgentThread } from "../McpjamAgentThread";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";

function renderWithError(body: unknown) {
  sessionState.error = new Error(JSON.stringify(body));
  render(
    <PreferencesStoreProvider themeMode="dark" themePreset="default">
      <McpjamAgentThread
        sessionId="agent-refusal-session"
        projectId="project-1"
        organizationId="org-1"
        surface="test"
      />
    </PreferencesStoreProvider>,
  );
}

describe("McpjamAgentThread refusal copy", () => {
  beforeEach(() => {
    useMCPJamLimitDialogStore.setState({ isOpen: false });
    sessionState.error = undefined;
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
});
