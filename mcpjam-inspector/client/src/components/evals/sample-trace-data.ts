import type { ModelDefinition } from "@/shared/types";
import type { TraceEnvelope } from "./trace-viewer-adapter";

/** Simulated wall-clock start for the sample trace (2026-03-15 14:30:00 UTC). */
export const SAMPLE_TRACE_STARTED_AT_MS = 1773854400000;

/** Example model row for the sample trace dialog (matches typical CI trace metadata). */
export const SAMPLE_TRACE_VIEWER_MODEL: ModelDefinition = {
  id: "gpt-4o",
  name: "GPT-4o",
  provider: "openai",
};

/**
 * Realistic two-prompt trace aligned with the SDK quickstart (greet + Ada).
 * Structure mirrors the waterfall fixture in `trace-viewer.test.tsx`.
 */
export const SAMPLE_TRACE: TraceEnvelope = {
  traceVersion: 1,
  messages: [
    {
      role: "user",
      content: "Use the greet tool to say hello to Ada.",
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-greet",
          toolName: "greet",
          input: { name: "Ada" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-greet",
          toolName: "greet",
          output: {
            type: "json",
            value: { greeting: "Hello, Ada! Nice to meet you." },
          },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "The greet tool returned a hello for Ada. Anything else you’d like to try?",
        },
      ],
    },
    { role: "user", content: "Summarize what you did in one sentence." },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I called the `greet` tool with Ada’s name and relayed its greeting back to you.",
        },
      ],
    },
  ],
  spans: [
    {
      id: "p0-step0",
      name: "Step 1",
      category: "step",
      startMs: 0,
      endMs: 125,
      promptIndex: 0,
      stepIndex: 0,
      status: "ok",
      modelId: "gpt-4o",
      inputTokens: 48,
      outputTokens: 28,
      totalTokens: 76,
      messageStartIndex: 1,
      messageEndIndex: 3,
    },
    {
      id: "p0-llm0",
      parentId: "p0-step0",
      name: "LLM",
      category: "llm",
      startMs: 0,
      endMs: 52,
      promptIndex: 0,
      stepIndex: 0,
      status: "ok",
      modelId: "gpt-4o",
      inputTokens: 48,
      outputTokens: 28,
      totalTokens: 76,
      messageStartIndex: 1,
      messageEndIndex: 3,
    },
    {
      id: "p0-tool0",
      parentId: "p0-step0",
      name: "greet",
      category: "tool",
      startMs: 42,
      endMs: 98,
      promptIndex: 0,
      stepIndex: 0,
      status: "ok",
      toolCallId: "call-greet",
      toolName: "greet",
      serverId: "learn-mcp",
      messageStartIndex: 1,
      messageEndIndex: 2,
    },
    {
      id: "p1-step0",
      name: "Step 1",
      category: "step",
      startMs: 145,
      endMs: 248,
      promptIndex: 1,
      stepIndex: 0,
      status: "ok",
      modelId: "gpt-4o",
      inputTokens: 36,
      outputTokens: 22,
      totalTokens: 58,
      messageStartIndex: 5,
      messageEndIndex: 5,
    },
    {
      id: "p1-llm0",
      parentId: "p1-step0",
      name: "LLM",
      category: "llm",
      startMs: 145,
      endMs: 238,
      promptIndex: 1,
      stepIndex: 0,
      status: "ok",
      modelId: "gpt-4o",
      inputTokens: 36,
      outputTokens: 22,
      totalTokens: 58,
      messageStartIndex: 5,
      messageEndIndex: 5,
    },
  ],
};
