/**
 * The prompt-ordinal contract that anchors a per-turn rating.
 *
 * A rating is stored against the `turnId` the SERVER minted, looked up by the
 * ordinal the server assigned. If the client and the server disagree about how
 * to count prompts, a rating silently attaches to the wrong response — so this
 * pins the convention against the server's own `getPromptIndex`, which is the
 * authority, rather than against the render filter (a different question).
 */
import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import type { UIMessage } from "@ai-sdk/react";
import { getPromptIndex } from "../../../../server/utils/live-chat-trace-stream";
// The PRODUCTION helper `ChatTabV2` calls — not a copy. A copy could not catch
// the divergence this file exists to prevent.
import { buildAssistantPromptIndex } from "../chat-v2/turn-ordinals";

type TestMessage = Pick<UIMessage, "id" | "role">;

const assistantPromptIndexById = (messages: TestMessage[]) =>
  buildAssistantPromptIndex(messages);

describe("assistant prompt ordinals", () => {
  it("assigns each response the ordinal of the prompt that opened its turn", () => {
    const map = assistantPromptIndexById([
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "u2", role: "user" },
      { id: "a2", role: "assistant" },
    ]);
    expect(map.get("a1")).toBe(0);
    expect(map.get("a2")).toBe(1);
  });

  it("leaves an assistant message before any prompt unmapped", () => {
    // A seeded greeting belongs to no turn, so no rating widget renders under
    // it — `undefined` is the signal the render callback checks.
    const map = assistantPromptIndexById([
      { id: "a0", role: "assistant" },
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
    ]);
    expect(map.has("a0")).toBe(false);
    expect(map.get("a1")).toBe(0);
  });

  it("skips a message with no id rather than mapping undefined", () => {
    const map = assistantPromptIndexById([
      { id: "u1", role: "user" },
      { id: "", role: "assistant" },
      { id: "a1", role: "assistant" },
    ] as TestMessage[]);
    expect(map.has("")).toBe(false);
    expect(map.get("a1")).toBe(0);
  });

  it("returns an empty map for an empty thread", () => {
    expect(assistantPromptIndexById([]).size).toBe(0);
  });

  it("counts prompts exactly as the server does", () => {
    // `getPromptIndex` is what stamps `chatSessionTurnTraces.promptIndex`, and
    // `turnIdByPromptIndex` looks turns up by that number. It counts EVERY
    // user-role message with no internal-message filtering — so the client must
    // not filter either. Injected `widget-state-*` messages are `role:
    // "assistant"` (see `applyWidgetStateUpdates`), so they are outside this
    // count on both sides.
    const history = [
      { role: "user", content: "first" },
      { role: "assistant", content: "a" },
      { role: "assistant", content: "widget state" },
      { role: "user", content: "second" },
    ] as unknown as ModelMessage[];

    const serverOrdinal = getPromptIndex(history);
    const clientMap = assistantPromptIndexById([
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "widget-state-tool-1", role: "assistant" },
      { id: "u2", role: "user" },
      { id: "a2", role: "assistant" },
    ]);

    // The server is mid-turn-2 (ordinal 1); the response to that prompt maps to
    // the same number on the client.
    expect(serverOrdinal).toBe(1);
    expect(clientMap.get("a2")).toBe(1);
    // The injected assistant message never shifted anything.
    expect(clientMap.get("a1")).toBe(0);
  });
});
