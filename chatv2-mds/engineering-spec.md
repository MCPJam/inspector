# Chat Playground V2 Engineering Spec

## Overview
We will replace the legacy MCP Playground front-end and the bespoke `useChat` hook with a cleaner implementation based on the Vercel AI SDK primitives. The goal is to reach feature parity with today’s chat experience while unblocking MCP-UI tooling, OpenAI Apps SDK integration, elicitation prompts, and future multiple-session support. This document captures the architecture, data contracts, rollout plan, and concrete code changes required to implement the V2 experience.

Target completion: end of next week.

## Requirements
- Preserve existing chat functionality (streaming responses, tool calls, elicitation dialog, model selection, free chat).
- Expose the new experience via a feature flag until QA is complete.
- Adopt Vercel AI SDK `streamText` on the backend and `useChat` / Assistant UI helpers on the frontend; remove the custom `client/src/hooks/use-chat.ts` dependency.
- Provide hooks for MCP-UI and OpenAI Apps SDK integrations.
- Lay groundwork for optional human-in-the-loop approvals and multiple chat sessions.

## Architecture & Implementation

### 1. Feature Flagging & Tab Wiring
Introduce an opt-in flag that can be toggled independently in browser (Vite) and server environments. When enabled, we render `ChatTabV2` instead of `ChatTab` and expose a beta nav item.

```ts
// client/src/config/feature-flags.ts
export const featureFlags = {
  chatV2: import.meta.env.VITE_ENABLE_CHAT_V2 === "true",
  chatV2Sessions: import.meta.env.VITE_ENABLE_CHAT_V2_SESSIONS === "true",
  chatV2AssistantUi: import.meta.env.VITE_ENABLE_CHAT_V2_ASSISTANT_UI === "true",
};
```

```ts
// server/config/feature-flags.ts
export const serverFeatureFlags = {
  chatV2: process.env.ENABLE_CHAT_V2 === "true",
  chatV2Approvals: process.env.ENABLE_CHAT_V2_APPROVALS === "true",
};
```

```ts
// client/src/App.tsx
import { featureFlags } from "@/config/feature-flags";
import { ChatTab } from "./components/ChatTab";
import { ChatTabV2 } from "./components/ChatTabV2";
...
const ChatSurface = featureFlags.chatV2 ? ChatTabV2 : ChatTab;
...
{activeTab === "chat" && (
  <ChatSurface
    serverConfigs={selectedMCPConfigsMap}
    connectedServerConfigs={connectedServerConfigs}
  />
)}
```

```ts
// client/src/components/mcp-sidebar.tsx
import { featureFlags } from "@/config/feature-flags";
...
{
  title: featureFlags.chatV2 ? "Playground (beta)" : "Playground",
  url: "#chat",
  icon: MessageCircle,
},
```

### 2. Backend Route (`server/routes/mcp/chat-v2.ts`)
Create a parallel Hono route that uses `streamText` directly. Stream events are expressed using the AI SDK’s `DataStreamWriter` helper, yielding the same SSE protocol the frontend expects.

```ts
// server/routes/mcp/chat-v2.ts
import { Hono } from "hono";
import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMcpRuntime } from "@/server/runtime/mcp-runtime";
import { mapClientMessageToAiSdk, buildToolset } from "@/server/utils/chat-v2";
import { serverFeatureFlags } from "../config/feature-flags";
import type { ChatV2Request } from "@/shared/chat-v2";

const chatV2 = new Hono();

chatV2.post("/", async (c) => {
  if (!serverFeatureFlags.chatV2) {
    return c.notFound();
  }

  const body = await c.req.json<ChatV2Request>();
  const sessionId = body.sessionId ?? crypto.randomUUID();

  const provider = body.provider === "openai"
    ? createOpenAI({ apiKey: body.apiKey ?? process.env.OPENAI_API_KEY })
    : await createMcpRuntime({
        selectedServers: body.selectedServers,
        requestId: sessionId,
      });

  const toolset = await buildToolset({
    provider,
    sessionId,
    enableApprovals: serverFeatureFlags.chatV2Approvals,
  });

  const result = await streamText({
    model: provider.chat(body.model),
    messages: body.messages.map(mapClientMessageToAiSdk),
    tools: toolset.tools,
    maxSteps: toolset.maxSteps,
    onStepFinish: toolset.handleStep,
    onError: toolset.handleError,
  });

  return result.toDataStreamResponse({
    headers: {
      "x-chat-session-id": sessionId,
    },
  });
});

export default chatV2;
```

Mount the route and gate it behind the flag:

```ts
// server/routes/mcp/index.ts
import { serverFeatureFlags } from "../config/feature-flags";
import chatV2 from "./chat-v2";
...
if (serverFeatureFlags.chatV2) {
  mcp.route("/chat-v2", chatV2);
}
```

Utility helpers shape provider/tool adapters and shared types.

```ts
// server/utils/chat-v2.ts
import type { Message, ToolSet } from "ai";
import type { ChatV2Message } from "@/shared/chat-v2";

export const mapClientMessageToAiSdk = (msg: ChatV2Message): Message => ({
  role: msg.role,
  content: msg.content,
  name: msg.name,
  toolInvocation: msg.toolInvocation,
});

export async function buildToolset(options: BuildToolsetOptions) {
  const tools: ToolSet = {
    ...getMcpTools(options.selectedServers),
    ...getOpenAiAppTools(options.sessionId),
  };

  return {
    tools,
    maxSteps: options.enableApprovals ? 8 : 6,
    handleStep: (event) => emitToolEvents(event, options.sessionId),
    handleError: (error) => logAndWrap(error, options.sessionId),
  };
}
```

### 3. Shared Types & Data Contracts
Define the request/response contract consumed by both client and server.

```ts
// shared/chat-v2.ts
export type ChatV2Role = "assistant" | "user" | "system" | "tool";

export interface ChatV2Message {
  id: string;
  role: ChatV2Role;
  content: string;
  createdAt: string;
  toolInvocation?: {
    name: string;
    args: Record<string, unknown>;
    status?: "pending" | "requires-approval" | "completed" | "error";
  };
  metadata?: Record<string, unknown>;
}

export interface ChatV2Request {
  sessionId?: string;
  model: string;
  provider: "openai" | "anthropic" | "mcp" | "ollama" | "router";
  apiKey?: string;
  messages: ChatV2Message[];
  temperature?: number;
  selectedServers?: string[];
  includeToolMetadata?: boolean;
  elicitationResponse?: {
    requestId: string;
    action: "accept" | "decline" | "cancel";
    payload?: unknown;
  };
}

export type ChatV2StreamEvent =
  | { type: "message"; message: ChatV2Message }
  | { type: "tool_call"; toolCall: ChatV2Message["toolInvocation"] & { id: string } }
  | { type: "tool_result"; toolResult: { id: string; result: unknown; error?: string } }
  | { type: "elicitation"; prompt: ChatV2Message }
  | { type: "done" };
```

### 4. Frontend Surface (`ChatTabV2.tsx`)
Leverage `useChat` from `ai/react` with custom handlers for tool approvals and elicitation. The component renders the same layout as V1 but consumes the new SSE schema.

```tsx
// client/src/components/ChatTabV2.tsx
import { useMemo, useState } from "react";
import { useChat } from "ai/react";
import { featureFlags } from "@/config/feature-flags";
import { MessageList } from "./chat-v2/MessageList";
import { ChatInput } from "./chat/chat-input";
import { ElicitationDialog } from "./ElicitationDialog";
import type { ChatTabProps } from "./ChatTab";

export function ChatTabV2(props: ChatTabProps) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const apiPath = useMemo(() => "/mcp/chat-v2", []);

  const chat = useChat({
    api: apiPath,
    body: {
      sessionId: activeSessionId,
      selectedServers: props.connectedServerConfigs
        ? Object.keys(props.connectedServerConfigs)
        : [],
    },
    onResponse(response) {
      const sessionId = response.headers.get("x-chat-session-id");
      if (sessionId && sessionId !== activeSessionId) {
        setActiveSessionId(sessionId);
      }
    },
    experimental_onToolCall: (toolCall) => {
      window.dispatchEvent(
        new CustomEvent("chat-v2:tool-call", { detail: toolCall }),
      );
    },
    experimental_onElicitation: (elicitation) => {
      setPendingElicitation(elicitation);
    },
  });

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
    stop,
  } = chat;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <MessageList
        messages={messages}
        approvalsEnabled={featureFlags.chatV2Sessions}
        onApproveTool={(payload) =>
          chat.append({ role: "user", content: JSON.stringify(payload) })
        }
      />
      <ChatInput
        value={input}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        isLoading={isLoading}
        onAbort={stop}
      />
      <ElicitationDialog
        request={pendingElicitation}
        onResolve={(action) =>
          chat.append({
            role: "user",
            content: action.payload,
            metadata: { elicitationRequestId: action.requestId },
          })
        }
      />
    </div>
  );
}
```

#### Assistant UI Spike
Wrap the `useChat` runtime with `@assistant-ui/react` to evaluate richer UI components. The spike can live in `client/src/components/chat-v2/AssistantRuntimeProvider.tsx` behind a second flag (`VITE_ENABLE_CHAT_V2_ASSISTANT_UI`).

```tsx
// client/src/components/chat-v2/AssistantRuntimeProvider.tsx
import {
  AssistantRuntimeProvider,
  createAssistantRuntime,
} from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-vercel";

export function ChatV2RuntimeProvider({ children }: { children: React.ReactNode }) {
  const runtime = useChatRuntime({ api: "/mcp/chat-v2" });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
```

### 5. Tool Approvals & MCP-UI Integration
- Emit tool call events from the backend by implementing `buildToolset` (above) to wrap MCP tool invocations. When `serverFeatureFlags.chatV2Approvals` is true, set `status: "requires-approval"` and pause execution until the frontend responds with an approval payload.
- Reuse existing MCP-UI components (`client/src/components/chat/tool-call-card.tsx`) by exporting them to `client/src/components/chat-v2/tool-call-card.tsx` and adapting props to the new schema.

```ts
// server/utils/chat-v2.ts (continuation)
export async function emitToolEvents(event: StepResult, sessionId: string) {
  if (!event.toolInvocation) return;

  const body = {
    type: "tool_call" as const,
    toolCall: {
      id: event.toolInvocation.id,
      name: event.toolInvocation.toolName,
      args: event.toolInvocation.args,
      status: event.toolInvocation.requiresApproval
        ? "requires-approval"
        : "pending",
    },
  } satisfies ChatV2StreamEvent;

  event.writer.write(body);
}
```

### 6. Multiple Sessions
Persist session metadata locally (for initial release) with optional backing store later.

```ts
// client/src/components/chat-v2/use-session-store.ts
import { create } from "zustand";

interface SessionState {
  sessions: Record<string, { title: string; createdAt: string }>;
  upsertSession(id: string, data: { title?: string }): void;
  removeSession(id: string): void;
}

export const useChatSessionStore = create<SessionState>((set) => ({
  sessions: {},
  upsertSession(id, data) {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [id]: {
          title: data.title ?? state.sessions[id]?.title ?? "New chat",
          createdAt: state.sessions[id]?.createdAt ?? new Date().toISOString(),
        },
      },
    }));
  },
  removeSession(id) {
    set((state) => {
      const { [id]: _, ...rest } = state.sessions;
      return { sessions: rest };
    });
  },
}));
```

Hook into `onResponse` (above) to call `upsertSession` and render a session switcher sidebar when `featureFlags.chatV2Sessions` is true.

### 7. Analytics & Telemetry
- Fire PostHog events on tab load and message send using the existing telemetry utilities.
- Add backend logs (`logger.info({ sessionId, provider }, "chat-v2 request")`).
- Surface `x-chat-session-id` header to correlate events between UI and server.

### 8. Error Handling
- Return structured error events (`{ type: "message", role: "assistant", content: "..." }`) on recoverable failures.
- For fatal errors, respond with HTTP 500 plus `X-Error-Code` header to help the UI differentiate network vs validation errors.

## Testing Plan
- **Unit**: validate `mapClientMessageToAiSdk`, `buildToolset`, feature flag helpers, and `useChatSessionStore` with Vitest.
- **Integration**: hit `/mcp/chat-v2` using mocked provider (use `@ai-sdk/provider-tools` mocks) to assert SSE stream shape.
- **Component**: render `ChatTabV2` with React Testing Library, simulate streaming events, verify elicitation dialog flows.
- **E2E**: add Playwright scenario with flag enabled via `VITE_ENABLE_CHAT_V2=true` to ensure streaming works end-to-end.

## Rollout
1. Land backend + shared types + feature flag (flag disabled by default).
2. Implement frontend UI, MCP/OpenAI wiring, and validation tests.
3. Smoke test on staging with `ENABLE_CHAT_V2=true`.
4. Enable for internal users, gather feedback via PostHog dashboards.
5. Remove legacy tab once confidence is high; delete `client/src/hooks/use-chat.ts` and related dead code.

## Open Questions
- Final decision on Assistant UI adoption vs custom components (needs spike Day 1).
- Where to persist multiple-session metadata long term (Convex vs local storage).
- Human approval UX – modal vs inline prompts; confirm desired blocking behavior with PM.

## Appendix
- [Vercel AI SDK Hono examples](https://ai-sdk.dev/cookbook/api-servers/hono)
- [Assistant UI Vercel integration](https://www.assistant-ui.com/docs/api-reference/integrations/vercel-ai-sdk)
