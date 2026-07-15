/**
 * SDK-ordering canary for WebMCP UI tool approval — runs against the REAL
 * `ai` / `@ai-sdk/react` packages (scripted transport, no HTTP).
 *
 * The approval design (PR: approval gating for UI tools) rests on verified
 * SDK behaviors that an `ai` upgrade could silently change. This file pins
 * them so the break surfaces here, not in production:
 *
 *   1. `onToolCall` fires on `tool-input-available`, BEFORE the
 *      `tool-approval-request` chunk applies — which is exactly why the
 *      executor must DEFER (the pill isn't rendered yet when the call
 *      lands).
 *   2. Approve-by-fulfillment: supplying the tool output on an
 *      `approval-requested` part moves it to `output-available`, counts as
 *      complete for `lastAssistantMessageIsCompleteWithToolCalls`
 *      (auto-resume fires), and `convertToModelMessages` serializes it as
 *      tool-call + tool-result with NO approval-response part.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/webmcp/native-mirror", () => ({
  mirrorUiToolToNative: vi.fn(() => null),
}));

import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "@ai-sdk/react";
import {
  convertToModelMessages,
  lastAssistantMessageIsCompleteWithToolCalls,
  type ChatTransport,
  type UIMessageChunk,
} from "ai";
import {
  __resetUiToolExecutorForTests,
  handleUiToolCall,
} from "@/lib/webmcp/ui-tool-executor";
import { createUiAwareApprovalResponseHandler } from "@/lib/webmcp/ui-tool-approval";
import {
  useUiToolsRegistry,
  type UiToolDefinition,
} from "@/lib/webmcp/ui-tools-registry";

const TOOL_CALL_ID = "tc-canary-1";
const APPROVAL_ID = "appr-canary-1";

function chunkStream(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** First turn: the model calls ui_navigate; the server gates it. */
const FIRST_TURN: UIMessageChunk[] = [
  { type: "start" },
  { type: "start-step" },
  {
    type: "tool-input-available",
    toolCallId: TOOL_CALL_ID,
    toolName: "ui_navigate",
    input: { target: "servers" },
    dynamic: true,
  },
  {
    type: "tool-approval-request",
    approvalId: APPROVAL_ID,
    toolCallId: TOOL_CALL_ID,
  },
  { type: "finish-step" },
  { type: "finish" },
] as UIMessageChunk[];

/** Resume turn: plain text answer. */
const RESUME_TURN: UIMessageChunk[] = [
  { type: "start" },
  { type: "start-step" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "Done." },
  { type: "text-end", id: "t1" },
  { type: "finish-step" },
  { type: "finish" },
] as UIMessageChunk[];

function registerNavigateTool(): UiToolDefinition {
  const def: UiToolDefinition = {
    name: "ui_navigate",
    description: "Navigate",
    readOnly: false,
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    })),
  };
  useUiToolsRegistry.getState().registerUiTool(def);
  return def;
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function findToolPart(chat: Chat<UIMessage>): any {
  for (const message of chat.messages) {
    for (const part of (message as any).parts ?? []) {
      if (part?.toolCallId === TOOL_CALL_ID) return part;
    }
  }
  return null;
}

describe("WebMCP approval — SDK ordering canary (real ai package)", () => {
  beforeEach(() => {
    __resetUiToolExecutorForTests();
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      shippedNames: new Set(),
    });
  });

  it("onToolCall fires before the approval request applies; approve-by-fulfillment resumes and serializes cleanly", async () => {
    const def = registerNavigateTool();
    const sendMessagesCalls: Array<{ messages: UIMessage[] }> = [];
    const transport: ChatTransport<UIMessage> = {
      sendMessages: async (options) => {
        sendMessagesCalls.push({ messages: options.messages });
        return chunkStream(
          sendMessagesCalls.length === 1 ? FIRST_TURN : RESUME_TURN
        );
      },
      reconnectToStream: async () => null,
    };

    const partStateAtOnToolCall: Array<{
      state: string | undefined;
      hasApproval: boolean;
    }> = [];

    const chat = new Chat<UIMessage>({
      id: "canary-session",
      transport,
      onToolCall: async ({ toolCall }) => {
        // PIN #1: at onToolCall time the part is input-available and the
        // approval request has NOT applied yet. If an ai upgrade reorders
        // this (approval before onToolCall), this assertion breaks first.
        const part = findToolPart(chat);
        partStateAtOnToolCall.push({
          state: part?.state,
          hasApproval: Boolean(part?.approval),
        });
        await handleUiToolCall({
          toolName: (toolCall as { toolName: string }).toolName,
          toolCallId: (toolCall as { toolCallId: string }).toolCallId,
          input: (toolCall as { input: unknown }).input,
          addToolOutput: (output) => {
            chat.addToolOutput(output);
          },
          requireToolApproval: true,
        });
      },
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    });

    await chat.sendMessage({ text: "navigate to servers" });
    await waitFor(() => chat.status === "ready", "first turn to settle");

    // The deferral held: the executor claimed the call without executing,
    // and the approval request then parked the part for the pill.
    expect(partStateAtOnToolCall).toEqual([
      { state: "input-available", hasApproval: false },
    ]);
    expect(def.execute).not.toHaveBeenCalled();
    expect(findToolPart(chat).state).toBe("approval-requested");
    expect(sendMessagesCalls).toHaveLength(1);

    // User clicks Approve → the UI-aware handler executes and ships the
    // result; NO approval response is sent.
    const addToolApprovalResponse = vi.fn((response) =>
      chat.addToolApprovalResponse(response)
    );
    const approve = createUiAwareApprovalResponseHandler({
      getMessages: () => chat.messages,
      addToolApprovalResponse,
      addToolOutput: (output) => {
        chat.addToolOutput(output);
      },
    });
    approve({ id: APPROVAL_ID, approved: true });

    // PIN #2: the completed tool set auto-resumes the turn.
    await waitFor(
      () => sendMessagesCalls.length === 2,
      "auto-resume after fulfillment"
    );
    await waitFor(() => chat.status === "ready", "resume turn to settle");

    expect(def.execute).toHaveBeenCalledWith({ target: "servers" });
    expect(addToolApprovalResponse).not.toHaveBeenCalled();
    const part = findToolPart(chat);
    expect(part.state).toBe("output-available");

    // PIN #3: serialization — tool-call + tool-result, and the unanswered
    // approval request does NOT become an approval-response.
    const modelMessages = await convertToModelMessages(
      sendMessagesCalls[1]!.messages as any
    );
    const flat = modelMessages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : []
    );
    const types = flat.map((c: any) => c.type);
    expect(types).toContain("tool-call");
    expect(types).toContain("tool-result");
    expect(types).not.toContain("tool-approval-response");
    const result = flat.find((c: any) => c.type === "tool-result") as any;
    expect(result.toolCallId).toBe(TOOL_CALL_ID);
  });
});
