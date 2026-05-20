import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { UIMessage } from "@ai-sdk/react";
import type { ProjectThreadOwnerAvatar } from "@/components/chat-v2/history/project-thread-owner-avatar";

// MessageView is heavy (parts pipeline, AI SDK hooks, design system).
// We only care that TranscriptThread feeds it the right
// `senderAvatar` + `showSenderAvatar` props per message, so render a stub
// that exposes them on `data-*` attributes.
vi.mock("../message-view", () => ({
  MessageView: (props: {
    message: UIMessage;
    senderAvatar?: ProjectThreadOwnerAvatar;
    showSenderAvatar?: boolean;
  }) => (
    <div
      data-testid={`mv-${props.message.id}`}
      data-show-sender-avatar={
        props.showSenderAvatar ? "true" : "false"
      }
      data-sender-status={props.senderAvatar?.status ?? "none"}
      data-sender-name={
        props.senderAvatar?.status === "show"
          ? props.senderAvatar.displayName
          : ""
      }
    />
  ),
}));

// Loading-indicator hook reads provider-aware host style. We don't care here.
vi.mock("@/components/chat-v2/shared/loading-indicator-content", () => ({
  useResolvedHostStyleForIndicator: () => null,
}));

import { TranscriptThread } from "../transcript-thread";

function userMessage(
  id: string,
  text: string,
  senderUserId?: string,
): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    ...(senderUserId
      ? { metadata: { senderUserId } as Record<string, unknown> }
      : {}),
  } as UIMessage;
}

function assistantMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

const baseProps = {
  model: {
    id: "test/model",
    name: "Test",
    provider: "openai" as const,
  } as never,
  toolsMetadata: {},
  toolServerMap: {} as never,
};

describe("TranscriptThread sender avatars", () => {
  it("renders no avatar when showSenderAvatars=false", () => {
    const messages = [
      userMessage("u1", "hello", "u-alice"),
      userMessage("u2", "again", "u-bob"),
    ];
    const { getByTestId } = render(
      <TranscriptThread
        {...baseProps}
        messages={messages}
        showSenderAvatars={false}
        resolveSenderAvatar={() => ({
          status: "show",
          displayName: "X",
        })}
      />,
    );

    expect(getByTestId("mv-u1").dataset.showSenderAvatar).toBe("false");
    expect(getByTestId("mv-u1").dataset.senderStatus).toBe("none");
    expect(getByTestId("mv-u2").dataset.showSenderAvatar).toBe("false");
  });

  it("shows the avatar on the first user message and coalesces consecutive same-sender prompts", () => {
    const messages = [
      userMessage("u1", "first", "u-alice"),
      userMessage("u2", "second by alice", "u-alice"),
      assistantMessage("a1", "ok"),
      userMessage("u3", "third by alice", "u-alice"),
    ];
    const resolve = (sender?: string): ProjectThreadOwnerAvatar =>
      sender === "u-alice"
        ? { status: "show", displayName: "Alice" }
        : { status: "generic" };

    const { getByTestId } = render(
      <TranscriptThread
        {...baseProps}
        messages={messages}
        showSenderAvatars={true}
        resolveSenderAvatar={resolve}
      />,
    );

    expect(getByTestId("mv-u1").dataset.showSenderAvatar).toBe("true");
    expect(getByTestId("mv-u1").dataset.senderName).toBe("Alice");
    // Same sender as previous user message → coalesce.
    expect(getByTestId("mv-u2").dataset.showSenderAvatar).toBe("false");
    // Same sender even across an assistant turn → still coalesce.
    expect(getByTestId("mv-u3").dataset.showSenderAvatar).toBe("false");
  });

  it("renders the avatar again when the sender changes", () => {
    const messages = [
      userMessage("u1", "alice 1", "u-alice"),
      userMessage("u2", "bob 1", "u-bob"),
      userMessage("u3", "bob 2", "u-bob"),
      userMessage("u4", "alice 2", "u-alice"),
    ];
    const resolve = (sender?: string): ProjectThreadOwnerAvatar => ({
      status: "show",
      displayName: sender === "u-alice" ? "Alice" : "Bob",
    });

    const { getByTestId } = render(
      <TranscriptThread
        {...baseProps}
        messages={messages}
        showSenderAvatars={true}
        resolveSenderAvatar={resolve}
      />,
    );

    expect(getByTestId("mv-u1").dataset.showSenderAvatar).toBe("true");
    expect(getByTestId("mv-u1").dataset.senderName).toBe("Alice");
    expect(getByTestId("mv-u2").dataset.showSenderAvatar).toBe("true");
    expect(getByTestId("mv-u2").dataset.senderName).toBe("Bob");
    expect(getByTestId("mv-u3").dataset.showSenderAvatar).toBe("false");
    expect(getByTestId("mv-u4").dataset.showSenderAvatar).toBe("true");
    expect(getByTestId("mv-u4").dataset.senderName).toBe("Alice");
  });
});
