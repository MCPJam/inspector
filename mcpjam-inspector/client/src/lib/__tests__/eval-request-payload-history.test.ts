import { describe, expect, it } from "vitest";
import { buildEvalRequestPayloadHistory } from "../eval-request-payload-history";

const serializedTools = {
  lookup_weather: {
    name: "lookup_weather",
    description: "Get weather for a city",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
    },
  },
};

describe("buildEvalRequestPayloadHistory", () => {
  it("builds a single-turn raw request without including the assistant reply", () => {
    const history = buildEvalRequestPayloadHistory({
      trace: {
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "What is the weather in SF?" },
          { role: "assistant", content: "It is 62F." },
        ],
        spans: [
          {
            id: "llm-1",
            name: "Model response",
            category: "llm",
            startMs: 0,
            endMs: 100,
            promptIndex: 0,
            stepIndex: 0,
            messageStartIndex: 2,
            messageEndIndex: 2,
          },
        ],
      },
      systemPrompt: "Be concise.",
      tools: serializedTools,
    });

    expect(history).toEqual([
      {
        turnId: "eval-turn-1",
        promptIndex: 0,
        stepIndex: 0,
        payload: {
          system: "Be concise.",
          tools: serializedTools,
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "What is the weather in SF?" },
          ],
        },
      },
    ]);
  });

  it("builds ordered raw payloads for multi-turn eval traces", () => {
    const history = buildEvalRequestPayloadHistory({
      trace: {
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "First question" },
          { role: "assistant", content: "First answer" },
          { role: "user", content: "Second question" },
          { role: "assistant", content: "Second answer" },
        ],
        spans: [
          {
            id: "llm-2",
            name: "Model response",
            category: "llm",
            startMs: 100,
            endMs: 200,
            promptIndex: 1,
            stepIndex: 0,
            messageStartIndex: 4,
            messageEndIndex: 4,
          },
          {
            id: "llm-1",
            name: "Model response",
            category: "llm",
            startMs: 0,
            endMs: 100,
            promptIndex: 0,
            stepIndex: 0,
            messageStartIndex: 2,
            messageEndIndex: 2,
          },
        ],
      },
      systemPrompt: "Be concise.",
      tools: {},
    });

    expect(history).toEqual([
      {
        turnId: "eval-turn-1",
        promptIndex: 0,
        stepIndex: 0,
        payload: {
          system: "Be concise.",
          tools: {},
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "First question" },
          ],
        },
      },
      {
        turnId: "eval-turn-2",
        promptIndex: 1,
        stepIndex: 0,
        payload: {
          system: "Be concise.",
          tools: {},
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "First question" },
            { role: "assistant", content: "First answer" },
            { role: "user", content: "Second question" },
          ],
        },
      },
    ]);
  });

  it("builds separate raw payloads for multiple model steps in one turn", () => {
    const history = buildEvalRequestPayloadHistory({
      trace: {
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Book me a table" },
          { role: "assistant", content: [{ type: "tool-call", toolName: "lookup_weather" }] },
          { role: "tool", content: [{ type: "tool-result", toolName: "lookup_weather", result: "Sunny" }] },
          { role: "assistant", content: "Booked." },
        ],
        spans: [
          {
            id: "llm-step-1",
            name: "First model step",
            category: "llm",
            startMs: 0,
            endMs: 50,
            promptIndex: 0,
            stepIndex: 0,
            messageStartIndex: 2,
            messageEndIndex: 2,
          },
          {
            id: "llm-step-2",
            name: "Second model step",
            category: "llm",
            startMs: 51,
            endMs: 100,
            promptIndex: 0,
            stepIndex: 1,
            messageStartIndex: 4,
            messageEndIndex: 4,
          },
        ],
      },
      systemPrompt: "Be concise.",
      tools: serializedTools,
    });

    expect(history).toEqual([
      {
        turnId: "eval-turn-1",
        promptIndex: 0,
        stepIndex: 0,
        payload: {
          system: "Be concise.",
          tools: serializedTools,
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Book me a table" },
          ],
        },
      },
      {
        turnId: "eval-turn-1",
        promptIndex: 0,
        stepIndex: 1,
        payload: {
          system: "Be concise.",
          tools: serializedTools,
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Book me a table" },
            {
              role: "assistant",
              content: [{ type: "tool-call", toolName: "lookup_weather" }],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolName: "lookup_weather",
                  result: "Sunny",
                },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("drops spans whose input cannot be reconstructed exactly", () => {
    const history = buildEvalRequestPayloadHistory({
      trace: {
        messages: [{ role: "assistant", content: "No prior context" }],
        spans: [
          {
            id: "llm-0",
            name: "Model response",
            category: "llm",
            startMs: 0,
            endMs: 100,
            promptIndex: 0,
            stepIndex: 0,
            messageStartIndex: 0,
            messageEndIndex: 0,
          },
        ],
      },
      systemPrompt: "Be concise.",
      tools: {},
    });

    expect(history).toEqual([]);
  });
});
