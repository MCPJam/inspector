/**
 * The `data-ui-context` part has to survive conversion to model messages.
 *
 * This is the failure mode worth a test: `convertToModelMessages` DROPS data
 * parts silently unless `convertDataPart` is supplied. Nothing errors — the
 * part validates, converts to nothing, and the model just never learns where
 * the user is. Everything looks green.
 */
import { describe, expect, it } from "vitest";
import { convertToMcpjamModelMessages } from "../mcp-tool-result-model-output";
import { UI_CONTEXT_OPEN, UI_CONTEXT_PART_TYPE } from "@/shared/ui-context";

const PAYLOAD = {
  path: "/servers",
  activeTab: "servers",
  selectedServers: ["everything"],
  timestamp: "2026-07-15T12:00:00.000Z",
};

function userMessage(parts: unknown[]) {
  return [{ id: "m1", role: "user", parts }] as never;
}

function textOf(messages: Array<{ content: unknown }>): string {
  return messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((p: any) => p?.type === "text")
    .map((p: any) => p.text)
    .join("\n");
}

describe("convertToMcpjamModelMessages — ui-context parts", () => {
  it("renders the part into model-visible text", async () => {
    const messages = await convertToMcpjamModelMessages(
      userMessage([
        { type: UI_CONTEXT_PART_TYPE, data: PAYLOAD },
        { type: "text", text: "what am I looking at?" },
      ]),
    );
    const text = textOf(messages as never);
    expect(text).toContain(UI_CONTEXT_OPEN);
    expect(text).toContain("servers (/servers)");
    expect(text).toContain("what am I looking at?");
  });

  it("keeps the user's own text when the context payload is malformed", async () => {
    // Orientation is a nice-to-have; a bad block must not cost the turn.
    const messages = await convertToMcpjamModelMessages(
      userMessage([
        { type: UI_CONTEXT_PART_TYPE, data: { path: 42 } },
        { type: "text", text: "hello" },
      ]),
    );
    const text = textOf(messages as never);
    expect(text).toContain("hello");
    expect(text).not.toContain(UI_CONTEXT_OPEN);
  });

  it("ignores unknown data parts", async () => {
    const messages = await convertToMcpjamModelMessages(
      userMessage([
        { type: "data-something-else", data: { x: 1 } },
        { type: "text", text: "hi" },
      ]),
    );
    expect(textOf(messages as never)).toBe("hi");
  });

  it("leaves ordinary messages untouched", async () => {
    const messages = await convertToMcpjamModelMessages(
      userMessage([{ type: "text", text: "plain" }]),
    );
    expect(textOf(messages as never)).toBe("plain");
  });
});
