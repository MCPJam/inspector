/**
 * The shared tool-call projection, and the dedupe change that came with it.
 *
 * Two callers used to carry their own copy of this walker (the eval runner and
 * the persisted-transcript predicate path), and both deduped by
 * `toolName + JSON.stringify(arguments)`. That single rule was doing two jobs
 * at once and getting one of them wrong: it correctly collapsed ONE call seen
 * through two sources, and it also silently collapsed TWO real calls that
 * happened to look alike. The tests below pin both halves, because the fix is
 * only correct if it keeps the first behaviour while dropping the second.
 */
import { describe, expect, test } from "vitest";
import {
  extractToolCallsExcludingPolicyBlocks,
  extractToolCallsFromConversation,
  mergeToolCalls,
  toolCallIdentity,
} from "../eval-tool-call-projection";

const assistantWithParts = (
  calls: Array<Record<string, unknown>>,
): Record<string, unknown> => ({
  role: "assistant",
  content: calls.map((call) => ({ type: "tool-call", ...call })),
});

describe("one call seen twice stays one call", () => {
  test("a step record and its message part collapse on the shared id", () => {
    const calls = extractToolCallsFromConversation({
      steps: [
        {
          toolCalls: [
            { toolName: "search", args: { q: "x" }, toolCallId: "call_1" },
          ],
        },
      ],
      messages: [
        assistantWithParts([
          { toolName: "search", input: { q: "x" }, toolCallId: "call_1" },
        ]),
      ],
    });

    expect(calls).toEqual([
      { toolName: "search", arguments: { q: "x" }, toolCallId: "call_1" },
    ]);
  });

  test("an id-less duplicate still collapses on value, as it always did", () => {
    // Legacy transcripts carry no ids. Their projection must not suddenly
    // count one call's two appearances as two executions.
    const calls = extractToolCallsFromConversation({
      steps: [{ toolCalls: [{ toolName: "search", args: { q: "x" } }] }],
      messages: [
        assistantWithParts([{ toolName: "search", input: { q: "x" } }]),
      ],
    });

    expect(calls).toHaveLength(1);
  });
});

describe("two calls that look alike are two calls", () => {
  test("repeated identical calls with distinct ids all survive", () => {
    // THE BEHAVIOUR CHANGE. A model that called `search{q:"x"}` three times
    // really did call it three times, and an eval measuring how many times a
    // tool was called cannot be handed one.
    const calls = extractToolCallsFromConversation({
      messages: [
        assistantWithParts([
          { toolName: "search", input: { q: "x" }, toolCallId: "call_1" },
        ]),
        assistantWithParts([
          { toolName: "search", input: { q: "x" }, toolCallId: "call_2" },
        ]),
        assistantWithParts([
          { toolName: "search", input: { q: "x" }, toolCallId: "call_3" },
        ]),
      ],
    });

    expect(calls.map((c) => c.toolCallId)).toEqual([
      "call_1",
      "call_2",
      "call_3",
    ]);
  });

  test("execution order is preserved, not sorted or grouped", () => {
    const calls = extractToolCallsFromConversation({
      messages: [
        assistantWithParts([
          { toolName: "b", input: {}, toolCallId: "1" },
          { toolName: "a", input: {}, toolCallId: "2" },
          { toolName: "b", input: {}, toolCallId: "3" },
        ]),
      ],
    });

    expect(calls.map((c) => c.toolName)).toEqual(["b", "a", "b"]);
  });
});

describe("shape handling", () => {
  test("reads every argument spelling the two engines produce", () => {
    const calls = extractToolCallsFromConversation({
      messages: [
        assistantWithParts([
          { toolName: "a", input: { via: "input" }, toolCallId: "1" },
          { toolName: "b", parameters: { via: "parameters" }, toolCallId: "2" },
          { toolName: "c", args: { via: "args" }, toolCallId: "3" },
          { name: "d", toolCallId: "4" },
        ]),
      ],
    });

    expect(calls).toEqual([
      { toolName: "a", arguments: { via: "input" }, toolCallId: "1" },
      { toolName: "b", arguments: { via: "parameters" }, toolCallId: "2" },
      { toolName: "c", arguments: { via: "args" }, toolCallId: "3" },
      { toolName: "d", arguments: {}, toolCallId: "4" },
    ]);
  });

  test("reads the inline `toolCalls` array on an assistant message", () => {
    const calls = extractToolCallsFromConversation({
      messages: [
        {
          role: "assistant",
          toolCalls: [
            { toolName: "search", args: { q: "x" }, toolCallId: "1" },
          ],
        },
      ],
    });

    expect(calls).toEqual([
      { toolName: "search", arguments: { q: "x" }, toolCallId: "1" },
    ]);
  });

  test("ignores non-assistant messages, malformed items and nameless calls", () => {
    expect(
      extractToolCallsFromConversation({
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "1" }] },
          assistantWithParts([{ input: {}, toolCallId: "2" }]),
          { role: "assistant", content: [null, "text", 42] },
          null,
        ],
      }),
    ).toEqual([]);
  });
});

describe("policy blocks", () => {
  test("a blocked call is excluded; an id-less one is kept", () => {
    // A blocked call never reached its server, so counting it would grade the
    // run on something that did not happen. A call with no id cannot be
    // matched against the blocked set, and dropping those to be safe would
    // silently empty a legacy transcript's projection.
    const calls = extractToolCallsExcludingPolicyBlocks(
      {
        messages: [
          assistantWithParts([
            { toolName: "blocked", input: {}, toolCallId: "call_blocked" },
            { toolName: "allowed", input: {}, toolCallId: "call_ok" },
            { toolName: "legacy", input: { q: 1 } },
          ]),
        ],
      },
      new Set(["call_blocked"]),
    );

    expect(calls.map((c) => c.toolName)).toEqual(["allowed", "legacy"]);
  });
});

describe("merging accumulated projections", () => {
  test("keeps order, drops a re-seen execution, keeps a genuine repeat", () => {
    const merged = mergeToolCalls(
      [{ toolName: "search", arguments: { q: "x" }, toolCallId: "1" }],
      [
        { toolName: "search", arguments: { q: "x" }, toolCallId: "1" },
        { toolName: "search", arguments: { q: "x" }, toolCallId: "2" },
      ],
    );

    expect(merged.map((c) => c.toolCallId)).toEqual(["1", "2"]);
  });
});

describe("identity", () => {
  test("an id and a value identity can never collide", () => {
    // The two namespaces are prefixed, so a tool literally named
    // `id:call_1`-ish cannot forge a collision with a real id.
    expect(
      toolCallIdentity({ toolName: "a", arguments: {}, toolCallId: "x" }),
    ).not.toBe(toolCallIdentity({ toolName: "a", arguments: {} }));
  });
});
