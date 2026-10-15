import { useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import type { AppToolInvocationUpdate } from "../thread/app-tool-invocations";
import { Thread } from "../thread";

const { messageView } = vi.hoisted(() => ({ messageView: vi.fn() }));

vi.mock("../thread/mcp-apps/use-widget-host", () => ({
  InspectorWidgetHostProvider: ({ children }: { children: ReactNode }) =>
    children,
}));
vi.mock("../thread/message-view", () => ({
  MessageView: (props: { message: UIMessage }) => {
    messageView(props);
    return (
      <div>
        {props.message.parts
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("")}
      </div>
    );
  },
}));
vi.mock("../thread/parts/app-tool-invocation-part", () => ({
  AppToolInvocationPart: ({
    invocation,
  }: {
    invocation: AppToolInvocationUpdate;
  }) => <div data-testid="app-invocation">{invocation.toolName}</div>,
}));
vi.mock("../shared/thinking-indicator", () => ({
  ThinkingIndicator: () => null,
}));
vi.mock("../fullscreen-chat-overlay", () => ({
  FullscreenChatOverlay: () => null,
}));

const model = {
  id: "test",
  name: "Test",
  provider: "openai" as const,
  contextWindow: 8192,
  maxOutputTokens: 4096,
  supportsTools: true,
  supportsVision: false,
  supportsStreaming: true,
};
const parentMessage: UIMessage = {
  id: "parent",
  role: "assistant",
  parts: [
    {
      type: "tool-example",
      toolCallId: "parent-tool",
      state: "output-available",
      input: {},
      output: {},
    },
  ],
};

// Keep the real Thread and its cleanup effect; stub presentation/host services.
// The external-store driver matches AI SDK 6, used by the affected 3.13 release.
describe("Thread streaming", () => {
  it.each(["empty", "retained", "removed"] as const)(
    "handles a buffered burst (app invocation: %s) and prunes removed tools",
    async (mode) => {
      const withInvocation = mode !== "empty";
      let messages: UIMessage[] = withInvocation ? [parentMessage] : [];
      const listeners = new Set<() => void>();
      const subscribe = (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
      const getSnapshot = () => messages;
      const publish = (next: UIMessage[]) => {
        messages = next;
        for (const listener of listeners) listener();
      };
      function Chat() {
        const snapshot = useSyncExternalStore(subscribe, getSnapshot);
        return (
          <Thread
            chatSessionId="buffered-reply"
            messages={snapshot}
            model={model}
            sendFollowUpMessage={() => {}}
            isLoading
            toolsMetadata={{}}
            toolServerMap={{}}
            minimalMode
          />
        );
      }
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(<Chat />));
        if (withInvocation) {
          const props = messageView.mock.lastCall![0] as {
            onAppToolInvocationChange: (
              invocation: AppToolInvocationUpdate,
            ) => void;
          };
          await act(async () =>
            props.onAppToolInvocationChange({
              id: "app-call",
              parentToolCallId: "parent-tool",
              toolName: "Retained tool",
              status: "success",
              startedAt: 1,
              completedAt: 2,
            }),
          );
        }
        if (mode === "removed") {
          // Remove the parent while cleanup still competes with chunk renders.
          publish([]);
          await Promise.resolve();
        }
        // Promise jobs without task breaks reproduce buffered stream chunks.
        // act() around this loop would drain pending work and hide the failure.
        for (let i = 1; i <= 100; i++) {
          publish([
            ...(mode === "retained" ? [parentMessage] : []),
            {
              id: "reply",
              role: "assistant",
              parts: [{ type: "text", text: `Chunk ${i}` }],
            },
          ]);
          await Promise.resolve();
        }
        await act(async () => {});
        expect(host.textContent).toContain("Chunk 100");
        if (mode === "retained") {
          expect(
            host.querySelector('[data-testid="app-invocation"]'),
          ).toHaveTextContent("Retained tool");
          const reply = messages[messages.length - 1]!;
          await act(async () => publish([reply]));
        }
        if (withInvocation) {
          const reply = messages[messages.length - 1]!;
          // Reintroducing its former parent must not resurrect a pruned call.
          await act(async () => publish([parentMessage, reply]));
          expect(
            host.querySelector('[data-testid="app-invocation"]'),
          ).toBeNull();
        }
      } finally {
        await act(async () => root.unmount());
        host.remove();
        messageView.mockClear();
      }
    },
  );
});
