import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage, ToolSet } from "ai";
import { runDirectChatTurn } from "../direct-chat-turn";
import { estimateModelTokens } from "@/shared/model-context-budget";

/**
 * PLB-300: the direct (BYOK) engine bounds each step's messages. It rebuilds
 * every step from the unfitted history, so a capped result reads the same on
 * every step and a presentation transform is applied once per step, not again
 * on the previous step's output.
 */

const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: (...args: unknown[]) => streamTextMock(...args),
    stepCountIs: vi.fn(() => undefined),
  };
});

const BASE64 = "QUJD".repeat(60_000);

const history: ModelMessage[] = [
  { role: "user", content: "Download the quote" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "download_quote_document",
        input: {},
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "download_quote_document",
        output: { type: "text", value: BASE64 },
      },
    ],
  },
];

type PrepareStep = (args: {
  stepNumber: number;
  messages?: ModelMessage[];
  initialMessages?: ModelMessage[];
  responseMessages?: ModelMessage[];
}) => Promise<{ messages?: ModelMessage[] }>;

function startTurn(
  overrides: Partial<Parameters<typeof runDirectChatTurn>[0]> = {},
) {
  const onContextCompaction = vi.fn();
  runDirectChatTurn({
    llmModel: { id: "mock" } as never,
    modelId: "gpt-4.1",
    messageHistory: history,
    systemPrompt: "system",
    tools: {} as ToolSet,
    traceEvents: { onContextCompaction },
    ...overrides,
  });
  const options = streamTextMock.mock.calls[0]![0] as {
    prepareStep: PrepareStep;
  };
  return { prepareStep: options.prepareStep, onContextCompaction };
}

function toolText(messages: ModelMessage[] | undefined): string {
  const part = messages
    ?.filter((message) => message.role === "tool")
    .flatMap((message) => message.content as Array<Record<string, unknown>>)
    .find((candidate) => candidate.toolCallId === "c1");
  return String((part?.output as { value?: unknown } | undefined)?.value);
}

describe("runDirectChatTurn context budget", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    streamTextMock.mockReturnValue({
      consumeStream: async () => {},
      response: Promise.resolve({ messages: [] }),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({}),
      finishReason: Promise.resolve("stop"),
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("sends the start and end of an oversized result and reports it", async () => {
    const { prepareStep, onContextCompaction } = startTurn();
    const step = await prepareStep({
      stepNumber: 0,
      messages: history,
      initialMessages: history,
      responseMessages: [],
    });
    expect(toolText(step.messages)).toContain("[MCPJam cut ");
    expect(estimateModelTokens(toolText(step.messages))).toBeLessThan(25_000);
    expect(onContextCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        report: expect.objectContaining({
          shortened: [expect.objectContaining({ toolCallId: "c1" })],
        }),
      }),
    );
  });

  it("presents and cuts each step once, from the unfitted history", async () => {
    const fence = (messages: ModelMessage[]) =>
      messages.map((message) =>
        message.role !== "tool"
          ? message
          : ({
              ...message,
              content: (message.content as Array<Record<string, unknown>>).map(
                (part) => ({
                  ...part,
                  output: {
                    type: "text",
                    value: `<fence>\n${String((part.output as { value: unknown }).value)}\n</fence>`,
                  },
                }),
              ),
            } as ModelMessage),
      );
    const { prepareStep } = startTurn({ transformStepMessages: fence });
    const replies: ModelMessage[] = [];
    let carried: ModelMessage[] = history;
    const seen: string[] = [];
    for (let stepNumber = 0; stepNumber < 3; stepNumber++) {
      const step = await prepareStep({
        stepNumber,
        messages: carried,
        initialMessages: history,
        responseMessages: [...replies],
      });
      seen.push(toolText(step.messages));
      const reply: ModelMessage = {
        role: "assistant",
        content: `step ${stepNumber}`,
      };
      replies.push(reply);
      // What AI SDK 7 hands the next step: this step's output plus the reply.
      carried = [...(step.messages ?? carried), reply];
    }
    expect(new Set(seen).size).toBe(1);
    expect(seen[0].match(/<fence>/g)).toHaveLength(1);
    expect(seen[0].match(/\[MCPJam cut /g)).toHaveLength(1);
  });

  it("sizes the cap from the caller's context window", async () => {
    const { prepareStep } = startTurn({ modelContextTokens: 40_000 });
    const step = await prepareStep({
      stepNumber: 0,
      messages: history,
      initialMessages: history,
      responseMessages: [],
    });
    expect(estimateModelTokens(toolText(step.messages))).toBeLessThan(10_000);
  });

  it("drops earlier reasoning when clearing, except on OpenAI Responses", async () => {
    const earlierTurn = (id: string): ModelMessage[] => [
      { role: "user", content: `turn ${id}` },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          {
            type: "tool-call",
            toolCallId: id,
            toolName: "get_events",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: id,
            toolName: "get_events",
            output: { type: "text", value: "event ok. ".repeat(700) },
          },
        ],
      },
    ];
    const long: ModelMessage[] = [
      ...earlierTurn("a"),
      ...earlierTurn("b"),
      ...earlierTurn("c"),
      { role: "user", content: "next" },
    ];
    const reasoningLeft = async (provider: string) => {
      streamTextMock.mockClear();
      const { prepareStep, onContextCompaction } = startTurn({
        llmModel: { id: "mock", provider } as never,
        messageHistory: long,
        modelContextTokens: 10_000,
      });
      const step = await prepareStep({
        stepNumber: 0,
        messages: long,
        initialMessages: long,
        responseMessages: [],
      });
      expect(onContextCompaction).toHaveBeenCalled();
      return (step.messages ?? [])
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((part) => part.type === "reasoning").length;
    };
    expect(await reasoningLeft("anthropic.messages")).toBe(0);
    expect(await reasoningLeft("openai.responses")).toBe(3);
  });

  it("leaves a step alone when every result fits and nothing presents it", async () => {
    const small: ModelMessage[] = [{ role: "user", content: "hello" }];
    const { prepareStep } = startTurn({ messageHistory: small });
    const step = await prepareStep({
      stepNumber: 0,
      messages: small,
      initialMessages: small,
      responseMessages: [],
    });
    expect(step.messages).toBeUndefined();
  });
});
