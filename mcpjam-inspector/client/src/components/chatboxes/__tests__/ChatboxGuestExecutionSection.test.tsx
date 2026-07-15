import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import { ChatboxGuestExecutionSection } from "../ChatboxGuestExecutionSection";

vi.mock("@/hooks/useChatboxes", () => ({
  useChatboxMutations: () => ({
    setChatboxGuestExecution: vi.fn(),
  }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function createChatbox(overrides: Partial<ChatboxSettings> = {}): ChatboxSettings {
  return {
    chatboxId: "cb-1",
    projectId: "ws-1",
    name: "My Chatbox",
    hostStyle: "chatgpt",
    systemPrompt: "",
    modelId: "gpt-4",
    temperature: 0.7,
    requireToolApproval: false,
    allowGuestAccess: false,
    mode: "invited_only",
    namedHostId: "host-1",
    namedHostName: "Host",
    servers: [],
    link: {
      token: "t",
      path: "/c/t",
      url: "https://example.com/c/t",
      rotatedAt: 0,
      updatedAt: 0,
    },
    members: [],
    ...overrides,
  };
}

describe("ChatboxGuestExecutionSection", () => {
  it("reveals sub-settings only after enabling guest execution", async () => {
    const user = userEvent.setup();
    render(
      <ChatboxGuestExecutionSection
        chatbox={createChatbox({ allowGuestAccess: true, mode: "anyone_with_link" })}
      />,
    );

    expect(screen.queryByText("Guest computer")).not.toBeInTheDocument();

    await user.click(screen.getByRole("switch"));

    expect(screen.getByText("Guest computer")).toBeInTheDocument();
    expect(screen.getByText("Shared project skills")).toBeInTheDocument();
    expect(screen.queryByText("Claude Code harness")).not.toBeInTheDocument();
  });

  it("shows save only after making changes", async () => {
    const user = userEvent.setup();
    render(
      <ChatboxGuestExecutionSection
        chatbox={createChatbox({ allowGuestAccess: true, mode: "anyone_with_link" })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /save changes/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("switch"));

    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeInTheDocument();
  });
});
