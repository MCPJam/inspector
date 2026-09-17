/**
 * The closure helper is applied in THREE places to the same turn — the client
 * on Stop, the server at persist time, and the server at ingress — and web chat
 * ingests the full history every turn. If the three disagreed about a message
 * that already exists, whichever persist landed last would win, and the
 * conversation would change under the user depending on network timing.
 *
 * So the golden test here is not "does it produce something sensible": it is
 * that the client's projection and the server's write are the SAME BYTES.
 */
import { describe, expect, it } from "vitest";
import { convertToModelMessages, type UIMessage } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  INTERRUPTED_TOOL_CALL_TEXT,
  diffInterruptedToolParts,
  closeUnresolvedToolCalls,
  closeUnresolvedUiToolParts,
  isInterruptedToolResult,
  isUnresolvedUiToolPart,
  listUnresolvedToolCalls,
  uiToolPartInterruptedState,
} from "../turn-outcome-closure";

const TURN_ID = "turn-abc";

const assistantWithCalls = (
  calls: Array<{ id: string; name: string }>,
): ModelMessage =>
  ({
    role: "assistant",
    content: calls.map((call) => ({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      input: {},
    })),
  }) as unknown as ModelMessage;

const toolResult = (id: string, name: string): ModelMessage =>
  ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: name,
        output: { type: "json", value: { ok: true } },
      },
    ],
  }) as unknown as ModelMessage;

const user = (text: string): ModelMessage =>
  ({ role: "user", content: [{ type: "text", text }] }) as unknown as ModelMessage;

describe("listUnresolvedToolCalls", () => {
  it("returns only calls without results, in history order", () => {
    const messages = [
      user("hi"),
      assistantWithCalls([
        { id: "c1", name: "charge_card" },
        { id: "c2", name: "list_cards" },
      ]),
      toolResult("c2", "list_cards"),
      assistantWithCalls([{ id: "c3", name: "send_email" }]),
    ];
    expect(
      listUnresolvedToolCalls(messages, () => "never_started").map(
        (c) => c.toolCallId,
      ),
    ).toEqual(["c1", "c3"]);
  });

  it("asks the caller for each state rather than guessing", () => {
    const messages = [
      assistantWithCalls([
        { id: "c1", name: "charge_card" },
        { id: "c2", name: "list_cards" },
      ]),
    ];
    expect(
      listUnresolvedToolCalls(messages, (id) =>
        id === "c1" ? "outcome_unknown" : "never_started",
      ),
    ).toEqual([
      { toolCallId: "c1", toolName: "charge_card", state: "outcome_unknown" },
      { toolCallId: "c2", toolName: "list_cards", state: "never_started" },
    ]);
  });

  it("returns nothing for a fully resolved history", () => {
    const messages = [
      assistantWithCalls([{ id: "c1", name: "t" }]),
      toolResult("c1", "t"),
    ];
    expect(listUnresolvedToolCalls(messages, () => "never_started")).toEqual([]);
  });
});

describe("closeUnresolvedToolCalls", () => {
  it("SPLICES the result directly after its assistant message, not at the end", () => {
    // Providers reject a request whose tool call is not answered by the next
    // message. Appending would make the very next turn 400 — the exact failure
    // the closure exists to prevent.
    const messages = [
      user("hi"),
      assistantWithCalls([{ id: "c1", name: "charge_card" }]),
      user("again"),
    ];
    const closed = closeUnresolvedToolCalls(
      messages,
      listUnresolvedToolCalls(messages, () => "never_started"),
      { turnId: TURN_ID },
    );
    expect(closed.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
  });

  it("groups a step's calls into ONE tool message, in part order", () => {
    const messages = [
      assistantWithCalls([
        { id: "c1", name: "charge_card" },
        { id: "c2", name: "list_cards" },
      ]),
    ];
    const closed = closeUnresolvedToolCalls(
      messages,
      listUnresolvedToolCalls(messages, () => "never_started"),
    );
    expect(closed).toHaveLength(2);
    const content = (closed[1] as { content: Array<{ toolCallId: string }> })
      .content;
    expect(content.map((p) => p.toolCallId)).toEqual(["c1", "c2"]);
  });

  it("handles several assistant messages without shifting each other's indices", () => {
    const messages = [
      assistantWithCalls([{ id: "c1", name: "a" }]),
      user("mid"),
      assistantWithCalls([{ id: "c2", name: "b" }]),
    ];
    const closed = closeUnresolvedToolCalls(
      messages,
      listUnresolvedToolCalls(messages, () => "never_started"),
    );
    expect(closed.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("SAYS SO when the outcome is unknown, and reassures only when it can", () => {
    const messages = [
      assistantWithCalls([
        { id: "c1", name: "charge_card" },
        { id: "c2", name: "list_cards" },
      ]),
    ];
    const closed = closeUnresolvedToolCalls(
      messages,
      listUnresolvedToolCalls(messages, (id) =>
        id === "c1" ? "outcome_unknown" : "never_started",
      ),
    );
    const content = (
      closed[1] as {
        content: Array<{ output: { value: string } }>;
      }
    ).content;
    expect(content[0].output.value).toBe(
      INTERRUPTED_TOOL_CALL_TEXT.outcome_unknown,
    );
    expect(content[0].output.value).toContain("may have taken effect");
    expect(content[1].output.value).toBe(
      INTERRUPTED_TOOL_CALL_TEXT.never_started,
    );
  });

  it("is IDEMPOTENT — closing an already-closed history changes nothing", () => {
    // What makes it safe for the client and the server to both apply it.
    const messages = [assistantWithCalls([{ id: "c1", name: "t" }])];
    const once = closeUnresolvedToolCalls(
      messages,
      listUnresolvedToolCalls(messages, () => "never_started"),
      { turnId: TURN_ID },
    );
    const twice = closeUnresolvedToolCalls(
      once,
      listUnresolvedToolCalls(once, () => "never_started"),
      { turnId: TURN_ID },
    );
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("never mutates its input", () => {
    const messages = [assistantWithCalls([{ id: "c1", name: "t" }])];
    const before = JSON.stringify(messages);
    closeUnresolvedToolCalls(
      messages,
      listUnresolvedToolCalls(messages, () => "never_started"),
    );
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("is DETERMINISTIC across repeated runs", () => {
    const messages = [
      user("hi"),
      assistantWithCalls([
        { id: "c1", name: "a" },
        { id: "c2", name: "b" },
      ]),
    ];
    const states = listUnresolvedToolCalls(messages, () => "outcome_unknown");
    const a = JSON.stringify(closeUnresolvedToolCalls(messages, states, {
      turnId: TURN_ID,
    }));
    const b = JSON.stringify(closeUnresolvedToolCalls(messages, states, {
      turnId: TURN_ID,
    }));
    expect(a).toBe(b);
  });

  it("marks its results so a reader can tell them from a real tool error", () => {
    const messages = [assistantWithCalls([{ id: "c1", name: "t" }])];
    const closed = closeUnresolvedToolCalls(
      messages,
      listUnresolvedToolCalls(messages, () => "outcome_unknown"),
      { turnId: TURN_ID },
    );
    const part = (closed[1] as { content: unknown[] }).content[0];
    expect(isInterruptedToolResult(part)).toBe(true);
    expect(
      isInterruptedToolResult({
        type: "tool-result",
        output: { type: "error-text", value: "the tool threw" },
      }),
    ).toBe(false);
  });
});

describe("the client's half reads state conservatively", () => {
  it("input-available is outcome_unknown — the client cannot see dispatch", () => {
    // The server executes the tool and the browser learns nothing until a
    // result arrives, so the reassuring sentence is not the client's to give.
    expect(uiToolPartInterruptedState({ type: "tool-x", state: "input-available" })).toBe(
      "outcome_unknown",
    );
    expect(
      uiToolPartInterruptedState({ type: "tool-x", state: "input-streaming" }),
    ).toBe("never_started");
  });

  it("recognizes only tool parts still awaiting a result", () => {
    expect(
      isUnresolvedUiToolPart({
        type: "tool-charge_card",
        toolCallId: "c1",
        state: "input-available",
      }),
    ).toBe(true);
    expect(
      isUnresolvedUiToolPart({
        type: "dynamic-tool",
        toolCallId: "c1",
        state: "input-streaming",
      }),
    ).toBe(true);
    expect(
      isUnresolvedUiToolPart({
        type: "tool-charge_card",
        toolCallId: "c1",
        state: "output-available",
      }),
    ).toBe(false);
    expect(isUnresolvedUiToolPart({ type: "text", text: "hi" })).toBe(false);
    expect(
      isUnresolvedUiToolPart({ type: "tool-x", state: "input-available" }),
    ).toBe(false);
  });

  it("returns the SAME object when nothing was open", () => {
    const message = {
      role: "assistant",
      parts: [{ type: "text", text: "done" }],
    };
    expect(closeUnresolvedUiToolParts(message)).toBe(message);
  });
});

describe("GOLDEN: client-side and server-side closure are byte-identical", () => {
  /**
   * The whole point of the helper being shared. The client closes its local
   * partial message; the SDK converts that to model messages on the next
   * request; the server closes the same turn at persist time. Both ingests
   * carry the same history, so they can land in either order.
   */
  it("a call already sent to the server closes identically on both sides", async () => {
    const uiMessages: UIMessage[] = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "m2",
        role: "assistant",
        parts: [
          {
            type: "tool-charge_card",
            toolCallId: "c1",
            state: "input-available",
            input: {},
          },
        ],
      } as unknown as UIMessage,
    ];

    // 1. The client closes its local partial message on Stop.
    const clientClosed = uiMessages.map((message) =>
      message.role === "assistant"
        ? closeUnresolvedUiToolParts(message, { turnId: TURN_ID })
        : message,
    );
    const fromClient = (await convertToModelMessages(
      clientClosed as UIMessage[],
    )) as ModelMessage[];

    // 2. The server closes the same turn at persist time, from the OPEN
    //    history plus the dispatch state its builder witnessed.
    const openOnServer = (await convertToModelMessages(
      uiMessages,
    )) as ModelMessage[];
    const fromServer = closeUnresolvedToolCalls(
      openOnServer,
      listUnresolvedToolCalls(openOnServer, () => "outcome_unknown"),
      { turnId: TURN_ID },
    );

    const toolMessages = (messages: ModelMessage[]) =>
      messages.filter((m) => m.role === "tool");

    expect(JSON.stringify(toolMessages(fromClient))).toBe(
      JSON.stringify(toolMessages(fromServer)),
    );
    expect(fromClient.map((m) => m.role)).toEqual(
      fromServer.map((m) => m.role),
    );
  });

  it("a call the model never finished dictating reaches NEITHER side's history", () => {
    // `input-streaming` means the model has not finished emitting the
    // arguments, and `convertToModelMessages` drops such a part outright —
    // there is no complete call to convert. The server's own history is in the
    // same position for the same reason: the step never settled, so nothing
    // was appended.
    //
    // The client still closes it, because its OWN rendering has to stop
    // showing a spinner. The two sides agree on what matters: after either
    // closure, the history the next turn runs on has no open calls.
    const streaming: UIMessage = {
      id: "m2",
      role: "assistant",
      parts: [
        {
          type: "tool-charge_card",
          toolCallId: "c1",
          state: "input-streaming",
          input: {},
        },
      ],
    } as unknown as UIMessage;

    const closed = closeUnresolvedUiToolParts(streaming, { turnId: TURN_ID });
    const part = (closed.parts as Array<Record<string, unknown>>)[0];
    expect(part.state).toBe("output-error");
    expect(part.errorText).toBe(INTERRUPTED_TOOL_CALL_TEXT.never_started);

    return convertToModelMessages([closed] as UIMessage[]).then((converted) => {
      expect(
        listUnresolvedToolCalls(
          converted as ModelMessage[],
          () => "never_started",
        ),
      ).toEqual([]);
    });
  });

  it("the client's closure yields a history the server then treats as closed", async () => {
    // Idempotence across the boundary: the server's ingress guard must find
    // nothing left to do on a history the client already closed, or the two
    // would write different bytes for the same turn.
    const uiMessages: UIMessage[] = [
      {
        id: "m2",
        role: "assistant",
        parts: [
          {
            type: "tool-charge_card",
            toolCallId: "c1",
            state: "input-available",
            input: {},
          },
        ],
      } as unknown as UIMessage,
    ];
    const closed = uiMessages.map((m) =>
      closeUnresolvedUiToolParts(m, { turnId: TURN_ID }),
    );
    const converted = (await convertToModelMessages(
      closed as UIMessage[],
    )) as ModelMessage[];
    expect(listUnresolvedToolCalls(converted, () => "never_started")).toEqual(
      [],
    );
    // And closing it again is a no-op, byte for byte.
    expect(
      JSON.stringify(closeUnresolvedToolCalls(converted, [])),
    ).toBe(JSON.stringify(converted));
  });
});

describe("diffInterruptedToolParts", () => {
  const closed = (toolCallId: string, errorText: string, state = "outcome_unknown") => ({
    type: "tool-charge_card",
    toolCallId,
    state: "output-error",
    errorText,
    callProviderMetadata: { mcpjam: { interrupted: state } },
  });

  it("reports nothing when the two sides agree, which is the expected case", () => {
    const parts = [closed("c1", INTERRUPTED_TOOL_CALL_TEXT.outcome_unknown)];
    expect(
      diffInterruptedToolParts(
        [{ role: "assistant", parts }],
        [{ role: "assistant", parts }],
      ),
    ).toEqual([]);
  });

  it("names a call whose text changed under the reader", () => {
    // The server copy wins on rehydration, so a divergence would silently
    // rewrite what the user was told about a call that may have taken effect.
    expect(
      diffInterruptedToolParts(
        [{ role: "assistant", parts: [closed("c1", "Interrupted before this tool call started.")] }],
        [{ role: "assistant", parts: [closed("c1", INTERRUPTED_TOOL_CALL_TEXT.outcome_unknown)] }],
      ),
    ).toEqual([
      {
        toolCallId: "c1",
        local: "Interrupted before this tool call started.",
        server: INTERRUPTED_TOOL_CALL_TEXT.outcome_unknown,
      },
    ]);
  });

  it("a call the local copy never closed is not a disagreement", () => {
    expect(
      diffInterruptedToolParts(
        [{ role: "assistant", parts: [] }],
        [{ role: "assistant", parts: [closed("c1", INTERRUPTED_TOOL_CALL_TEXT.outcome_unknown)] }],
      ),
    ).toEqual([]);
  });

  it("ignores a tool that genuinely errored — that is not a closure", () => {
    expect(
      diffInterruptedToolParts(
        [
          {
            role: "assistant",
            parts: [
              {
                type: "tool-charge_card",
                toolCallId: "c1",
                state: "output-error",
                errorText: "the card was declined",
              },
            ],
          },
        ],
        [{ role: "assistant", parts: [closed("c1", INTERRUPTED_TOOL_CALL_TEXT.outcome_unknown)] }],
      ),
    ).toEqual([]);
  });

  it("does no work at all when nothing local was closed", () => {
    expect(
      diffInterruptedToolParts(
        [{ role: "assistant", parts: [{ type: "text", text: "hi" }] }],
        [{ role: "assistant", parts: [closed("c1", "x")] }],
      ),
    ).toEqual([]);
  });
});
