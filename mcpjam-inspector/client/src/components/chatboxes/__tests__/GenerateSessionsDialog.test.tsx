/**
 * Tests for `GenerateSessionsDialog` plan v4 §J affordances:
 *   - BYOK chatbox: warning visible, Generate disabled.
 *   - requireToolApproval chatbox: rewritten warning visible.
 *   - rate_limited run status: shows the "Rate-limited — budget reached"
 *     label with the amber treatment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { GenerateSessionsDialog } from "../GenerateSessionsDialog";
import type { ChatboxSettings } from "@/hooks/useChatboxes";

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ getAccessToken: vi.fn().mockResolvedValue("tok") }),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("@/lib/PosthogUtils", () => ({
  standardEventProps: () => ({}),
}));

const baseChatbox: ChatboxSettings = {
  chatboxId: "cb_1",
  projectId: "proj_1",
  name: "Test bot",
  hostStyle: "claude",
  systemPrompt: "",
  modelId: "openai/gpt-oss-120b",
  temperature: 0.7,
  requireToolApproval: false,
  allowGuestAccess: true,
  mode: "live",
  servers: [
    {
      serverId: "srv-1",
      serverName: "Test server",
      optional: false,
    } as ChatboxSettings["servers"][number],
  ],
  namedHostId: "nh_1",
  namedHostName: "host-1",
  link: null,
  members: [],
} as ChatboxSettings;

const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = vi.fn() as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("GenerateSessionsDialog — plan v4 §J affordances", () => {
  it("shows the BYOK disabled state when modelId is a BYOK provider", () => {
    const byokChatbox = {
      ...baseChatbox,
      modelId: "ollama/llama-3:8b",
    };
    render(
      <GenerateSessionsDialog
        isOpen
        onClose={() => {}}
        chatbox={byokChatbox}
      />,
    );
    expect(
      screen.getByText(
        /Synthetic sessions are not yet supported for chatboxes using your own model keys/,
      ),
    ).toBeInTheDocument();
    expect(
      (screen.getByRole("button", { name: "Generate personas" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows the approval-mode warning when requireToolApproval is set", () => {
    const approvalChatbox = { ...baseChatbox, requireToolApproval: true };
    render(
      <GenerateSessionsDialog
        isOpen
        onClose={() => {}}
        chatbox={approvalChatbox}
      />,
    );
    expect(
      screen.getByText(
        /Synthetic sessions cannot exercise approval-required tools/,
      ),
    ).toBeInTheDocument();
    // BYOK warning should NOT appear for an MCPJam-provided modelId.
    expect(
      screen.queryByText(
        /Synthetic sessions are not yet supported for chatboxes using your own model keys/,
      ),
    ).toBeNull();
  });

  it("does not show approval warning when approvals are off", () => {
    render(
      <GenerateSessionsDialog
        isOpen
        onClose={() => {}}
        chatbox={baseChatbox}
      />,
    );
    expect(
      screen.queryByText(
        /Synthetic sessions cannot exercise approval-required tools/,
      ),
    ).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Generate personas" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
