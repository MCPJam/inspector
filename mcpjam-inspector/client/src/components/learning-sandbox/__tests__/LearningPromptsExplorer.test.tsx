import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { LearningPromptsExplorer } from "../LearningPromptsExplorer";

const { useLearningServerMock, listPromptsMock, getPromptMock } = vi.hoisted(
  () => ({
    useLearningServerMock: vi.fn(),
    listPromptsMock: vi.fn(),
    getPromptMock: vi.fn(),
  }),
);

vi.mock("@/hooks/use-learning-server", () => ({
  useLearningServer: useLearningServerMock,
}));

vi.mock("@/lib/apis/mcp-prompts-api", () => ({
  listPrompts: listPromptsMock,
  getPrompt: getPromptMock,
}));

vi.mock("../LearningSandboxShell", () => ({
  LearningSandboxShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../LearningSandboxServerInfoPanel", () => ({
  LearningSandboxServerInfoPanel: () => null,
}));

describe("LearningPromptsExplorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLearningServerMock.mockReturnValue({
      serverId: "__learning__",
      serverEntry: undefined,
      initInfo: undefined,
      status: "connected",
      error: undefined,
      isConnected: true,
      isConnecting: false,
      connect: vi.fn(),
      reconnect: vi.fn(),
      disconnect: vi.fn(),
    });
  });

  it("ignores stale guided examples when discovery falls back to a different prompt", async () => {
    listPromptsMock.mockResolvedValue([
      {
        name: "fallback-prompt",
        description: "Fallback prompt description",
        arguments: [],
      },
    ]);
    getPromptMock.mockResolvedValue({ content: [] });

    render(<LearningPromptsExplorer />);

    await waitFor(() => {
      expect(listPromptsMock).toHaveBeenCalledWith("__learning__");
    });

    expect(
      await screen.findByText("Fallback prompt description"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Learn how prompts expose templated, reusable instructions separately from tools and resources.",
      ),
    ).not.toBeInTheDocument();
  });
});
