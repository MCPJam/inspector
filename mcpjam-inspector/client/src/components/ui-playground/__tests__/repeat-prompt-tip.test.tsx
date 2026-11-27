import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findSimilar, slot, mockTrack } = vi.hoisted(() => ({
  findSimilar: vi.fn(),
  slot: { active: true },
  mockTrack: vi.fn(),
}));

vi.mock("convex/react", () => ({ useAction: () => findSimilar }));
vi.mock("@/hooks/usePromoteCapability", () => ({
  usePromoteCapability: () => ({ canPromote: true, isLoading: false }),
}));
vi.mock("@/components/announcement-slot", () => ({
  useAnnouncementSlot: (eligible: boolean) => ({
    enabled: true,
    open: eligible && slot.active,
    contentRef: () => {},
  }),
}));
vi.mock("@/lib/analytics", () => ({ track: mockTrack }));
vi.mock("@/components/chat-v2/shared/save-as-test-case-action", () => ({
  SaveAsTestCaseAction: (props: {
    open: boolean;
    promptIndex: number;
    suggestedHostIds: string[];
    source?: string;
  }) =>
    props.open ? (
      <div data-testid="save-dialog">
        {props.promptIndex}|{props.suggestedHostIds.join(",")}|{props.source}
      </div>
    ) : null,
}));

import { RepeatPromptTip } from "../repeat-prompt-tip";
import { pickCompareTipSource } from "../repeat-prompt-match";

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function toolReply(id: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "list_issues",
        toolCallId: `${id}-call`,
        state: "output-available",
        input: {},
        output: {},
      },
    ],
  } as UIMessage;
}

function renderTip(messages: UIMessage[]) {
  return render(
    <RepeatPromptTip
      projectId="proj-1"
      chatSessionId="chat-1"
      messages={messages}
      isStreaming={false}
      serverNames={["Linear"]}
      hostIds={["host-a", "host-b"]}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  slot.active = true;
  findSimilar.mockReset();
  mockTrack.mockReset();
});

afterEach(() => {
  localStorage.clear();
});

describe("RepeatPromptTip", () => {
  it("shows on a repeat from a past conversation and opens the dialog with every client", async () => {
    findSimilar.mockResolvedValue({ promptText: "list open linear issues" });
    renderTip([user("u1", "List my open Linear issues"), toolReply("a1")]);

    expect(await screen.findByText("Tip")).toBeInTheDocument();
    expect(findSimilar).toHaveBeenCalledWith({
      projectId: "proj-1",
      chatSessionId: "chat-1",
      prompt: "List my open Linear issues",
      serverNames: ["Linear"],
      excludeChatSessionIds: [],
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Save as test case" }),
    );
    expect(screen.getByTestId("save-dialog")).toHaveTextContent(
      "0|host-a,host-b|repeat_tip",
    );
    expect(screen.queryByText("Tip")).not.toBeInTheDocument();
  });

  it("matches a repeat inside the same conversation without a backend call", async () => {
    renderTip([
      user("u1", "list open linear issues"),
      toolReply("a1"),
      user("u2", "List my open Linear issues"),
      toolReply("a2"),
    ]);
    expect(await screen.findByText("Tip")).toBeInTheDocument();
    expect(findSimilar).not.toHaveBeenCalled();
  });

  it("drops the match when the conversation changes", async () => {
    const { rerender } = renderTip([
      user("u1", "list open linear issues"),
      toolReply("a1"),
      user("u2", "List my open Linear issues"),
      toolReply("a2"),
    ]);
    expect(await screen.findByText("Tip")).toBeInTheDocument();

    rerender(
      <RepeatPromptTip
        projectId="proj-1"
        chatSessionId="chat-2"
        messages={[]}
        isStreaming={false}
        serverNames={["Linear"]}
        hostIds={["host-a", "host-b"]}
      />,
    );
    expect(screen.queryByText("Tip")).not.toBeInTheDocument();
  });

  it("stays hidden when the turn called no tools", async () => {
    renderTip([
      user("u1", "List my open Linear issues"),
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "ok" }] },
    ]);
    await waitFor(() => expect(findSimilar).not.toHaveBeenCalled());
    expect(screen.queryByText("Tip")).not.toBeInTheDocument();
  });

  it("waits behind other announcements and records seen only when shown", async () => {
    slot.active = false;
    findSimilar.mockResolvedValue({ promptText: "list open linear issues" });
    renderTip([user("u1", "List my open Linear issues"), toolReply("a1")]);
    await waitFor(() => expect(findSimilar).toHaveBeenCalled());
    expect(screen.queryByText("Tip")).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });

  it("does not show again for a server once seen, and dismiss hides it", async () => {
    findSimilar.mockResolvedValue({ promptText: "list open linear issues" });
    const { unmount } = renderTip([
      user("u1", "List my open Linear issues"),
      toolReply("a1"),
    ]);
    await userEvent.click(
      await screen.findByRole("button", { name: "Dismiss tip" }),
    );
    expect(screen.queryByText("Tip")).not.toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith("playground_repeat_tip_dismissed", {
      location: "playground",
    });
    unmount();

    findSimilar.mockClear();
    renderTip([user("u1", "List my open Linear issues"), toolReply("a1")]);
    await waitFor(() => expect(findSimilar).not.toHaveBeenCalled());
    expect(screen.queryByText("Tip")).not.toBeInTheDocument();
  });

  it("skips its own session and keeps sibling compare lanes out of the match", async () => {
    findSimilar.mockResolvedValue(null);
    render(
      <RepeatPromptTip
        projectId="proj-1"
        chatSessionId="lane-a"
        messages={[user("u1", "List my open Linear issues"), toolReply("a1")]}
        isStreaming={false}
        serverNames={["Linear"]}
        hostIds={["host-a"]}
        excludeChatSessionIds={["lane-a", "lane-b"]}
      />,
    );
    await waitFor(() =>
      expect(findSimilar).toHaveBeenCalledWith(
        expect.objectContaining({
          chatSessionId: "lane-a",
          excludeChatSessionIds: ["lane-b"],
        }),
      ),
    );
  });
});

describe("pickCompareTipSource", () => {
  it("picks the first lane whose latest turn called tools", () => {
    const noTools = {
      chatSessionId: "lane-a",
      messages: [
        user("u1", "List my open Linear issues"),
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
        } as UIMessage,
      ],
    };
    const withTools = {
      chatSessionId: "lane-b",
      messages: [user("u1", "List my open Linear issues"), toolReply("a1")],
    };
    expect(pickCompareTipSource([noTools, withTools])).toBe(withTools);
    expect(pickCompareTipSource([noTools])).toBeUndefined();
  });
});
