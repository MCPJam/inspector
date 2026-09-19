/**
 * THE INGRESS GUARD.
 *
 * Before this, `emitInheritedToolCalls` plus `executeToolCallsFromMessages` ran
 * EVERY unresolved call in the resent history on the next turn. That is right
 * for a call somebody is resuming and dangerous for every other one: a call the
 * user pressed Stop on would execute for real afterwards — after the Stop, with
 * no turn in flight and nobody watching.
 *
 * The guard inverts the rule: a call runs only when something NAMES it as a
 * resume. These tests are the four things that count as naming it, and the one
 * case that does not.
 *
 * This is a HARDENING that is independent of the persistence gates, which is
 * why it ships before them: it holds whatever the history's provenance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { isInterruptedToolResult } from "@/shared/turn-outcome-closure";

vi.mock("../harness/run-harness-turn", () => ({
  runHarnessTurn: vi.fn(),
}));

vi.mock("../mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

vi.mock("../logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    systemEvent: vi.fn(),
    event: vi.fn(),
  },
  captureOriginErrorToSentry: vi.fn(),
}));

// eslint-disable-next-line import/first
import { runChatEngineLoop } from "../mcpjam-stream-handler";

const encoder = new TextEncoder();
const sseResponse = (events: unknown[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `${events
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join("")}data: [DONE]\n\n`,
          ),
        );
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );

const OK_STREAM = [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "ok" },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: "stop" },
];

/** A tool that WOULD run if the guard let it through. */
const executed: string[] = [];
const runnableTool = (name: string, needsApproval?: boolean) => ({
  description: name,
  inputSchema: { type: "object" } as never,
  ...(needsApproval !== undefined ? { needsApproval } : {}),
  execute: async () => {
    executed.push(name);
    return { ok: true };
  },
});

/** A client-fulfilled tool: registered, but the BROWSER runs it. */
const clientFulfilledTool = (name: string) => ({
  description: name,
  inputSchema: { type: "object" } as never,
});

const managerStub = {
  getAllToolsMetadata: vi.fn().mockReturnValue({}),
  listServers: vi.fn().mockReturnValue([]),
  getToolsForAiSdk: vi.fn().mockResolvedValue({}),
};

async function runTurn(options: Record<string, unknown>) {
  return runChatEngineLoop(
    {
      modelId: "openai/gpt-5-mini",
      systemPrompt: "You are helpful",
      mcpClientManager: managerStub as never,
      ...options,
    } as never,
    "none",
  );
}

const historyWithOpenCall = (
  toolName: string,
  extraParts: unknown[] = [],
): ModelMessage[] =>
  [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName,
          input: {},
        },
        ...extraParts,
      ],
    },
  ] as unknown as ModelMessage[];

const toolResultsFor = (messages: ModelMessage[], toolCallId: string) =>
  messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => (m as { content: Array<Record<string, unknown>> }).content)
    .filter((p) => p.toolCallId === toolCallId);

describe("ingress guard", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    executed.length = 0;
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    global.fetch = vi.fn().mockResolvedValue(sseResponse(OK_STREAM));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("DOES NOT EXECUTE an inherited call with no resume marker — and closes it", async () => {
    // The whole point. This history is what a stopped turn leaves behind; the
    // old loop ran the call for real on the next turn.
    const messages = historyWithOpenCall("charge_card");
    const result = await runTurn({
      messages,
      tools: { charge_card: runnableTool("charge_card") },
    });

    expect(executed).toEqual([]);
    const closures = toolResultsFor(result.messageHistory, "call-1");
    expect(closures).toHaveLength(1);
    expect(isInterruptedToolResult(closures[0])).toBe(true);
    expect((closures[0] as { output: { value: string } }).output.value).toContain(
      "may have taken effect",
    );
  });

  it("closes it CONSERVATIVELY — the guard has no dispatch evidence of its own", async () => {
    // It is looking at a history that arrived from somewhere, so it cannot
    // promise the call did nothing. The persist-time closure, which does have
    // the builder's evidence, is the one that says `never_started`.
    const result = await runTurn({
      messages: historyWithOpenCall("charge_card"),
      tools: { charge_card: runnableTool("charge_card") },
    });
    const part = toolResultsFor(result.messageHistory, "call-1")[0] as {
      providerOptions: { mcpjam: { interrupted: string } };
    };
    expect(part.providerOptions.mcpjam.interrupted).toBe("outcome_unknown");
  });

  it("SPLICES the closure directly after the assistant message", async () => {
    // A provider rejects a request whose tool call is not answered by the next
    // message, so an appended result would 400 the very turn the guard is
    // protecting.
    const result = await runTurn({
      messages: historyWithOpenCall("charge_card"),
      tools: { charge_card: runnableTool("charge_card") },
    });
    expect(result.messageHistory.slice(0, 3).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("STANDS DOWN when the call is awaiting a human's approval", async () => {
    // The previous turn gated it and is waiting; the decision can still
    // arrive, and closing the call would destroy a pending approval the user
    // is looking at.
    //
    // Asserted on CLOSURE rather than on the absence of any result: what the
    // engine then does with a call the guard left alone is the engine's own
    // existing behaviour (here, approvals are off, so the approval-resume path
    // runs it), and this test is about the guard not intervening.
    const result = await runTurn({
      messages: historyWithOpenCall("charge_card", [
        {
          type: "tool-approval-request",
          approvalId: "approval-1",
          toolCallId: "call-1",
        },
      ]),
      tools: { charge_card: runnableTool("charge_card") },
    });
    expect(
      toolResultsFor(result.messageHistory, "call-1").filter(
        isInterruptedToolResult,
      ),
    ).toHaveLength(0);
  });

  it("STANDS DOWN when the call needs approval now", async () => {
    // The engine will re-emit the pill and pause again, so nothing here can run
    // unasked — and the approval-free siblings are the drain the resumed turn
    // depends on.
    const result = await runTurn({
      messages: historyWithOpenCall("charge_card"),
      tools: { charge_card: runnableTool("charge_card", true) },
      requireToolApproval: true,
    });
    expect(toolResultsFor(result.messageHistory, "call-1")).toHaveLength(0);
  });

  it("STANDS DOWN for the WHOLE STEP, not just the gated call", async () => {
    // The pause is whole-step: closing an approval-free sibling would strand
    // the discovery side effect the resumed turn depends on.
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "meta-1",
            toolName: "search_mcp_tools",
            input: {},
          },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "charge_card",
            input: {},
          },
        ],
      },
    ] as unknown as ModelMessage[];
    const result = await runTurn({
      messages,
      tools: {
        search_mcp_tools: runnableTool("search_mcp_tools", false),
        charge_card: runnableTool("charge_card", true),
      },
      requireToolApproval: true,
    });
    expect(toolResultsFor(result.messageHistory, "meta-1")).toHaveLength(0);
    expect(toolResultsFor(result.messageHistory, "call-1")).toHaveLength(0);
  });

  it("BUT ONLY FOR THAT STEP: an orphan in another message is still closed", async () => {
    // THE HOLE THIS CLOSES. The stand-down used to be whole-HISTORY — the first
    // approval it found stood the guard down for everything — and
    // `handlePendingApprovals` hands the WHOLE history to
    // `executeToolCallsFromMessages` with no filter, so it runs every
    // unresolved executable call it finds.
    //
    // A user stops a turn mid-`charge_card`, then approves something unrelated
    // two messages later. The approval click would have authorized the charge
    // they stopped. The stand-down is whole-STEP, which is what the pause
    // actually is; another assistant message is another step.
    const messages = [
      { role: "user", content: "charge it" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "orphan-1",
            toolName: "charge_card",
            input: {},
          },
        ],
      },
      { role: "user", content: "actually, search instead" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "gated-1",
            toolName: "delete_everything",
            input: {},
          },
          {
            type: "tool-approval-request",
            approvalId: "approval-1",
            toolCallId: "gated-1",
          },
        ],
      },
    ] as unknown as ModelMessage[];
    const result = await runTurn({
      messages,
      tools: {
        charge_card: runnableTool("charge_card"),
        delete_everything: runnableTool("delete_everything", true),
      },
    });
    // The approval's own call is untouched — a human is still looking at it.
    expect(
      toolResultsFor(result.messageHistory, "gated-1").filter(
        isInterruptedToolResult,
      ),
    ).toHaveLength(0);
    // The orphan from the stopped turn is CLOSED, so nothing downstream can
    // read it as work to do.
    expect(
      toolResultsFor(result.messageHistory, "orphan-1").filter(
        isInterruptedToolResult,
      ),
    ).toHaveLength(1);
  });

  it("STANDS DOWN for the call a scope step-up resume names, and its siblings", async () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "charge_card",
            input: {},
          },
          {
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "list_cards",
            input: {},
          },
        ],
      },
    ] as unknown as ModelMessage[];
    const result = await runTurn({
      messages,
      tools: {
        charge_card: runnableTool("charge_card"),
        list_cards: runnableTool("list_cards"),
      },
      scopeStepUpResume: {
        toolCallId: "call-1",
        resolve: vi.fn().mockResolvedValue({ kind: "suspended" }),
      },
    });
    // The sibling rides with it: the resume pre-phase pauses while any sibling
    // is unresolved, and closing one would make the driven result splice into a
    // step the engine has already declared finished.
    expect(toolResultsFor(result.messageHistory, "call-1")).toHaveLength(0);
    expect(toolResultsFor(result.messageHistory, "call-2")).toHaveLength(0);
  });

  it("STANDS DOWN for a registered CLIENT-FULFILLED call — the browser runs it", async () => {
    // This path never runs those anyway, and the loop's pause for them IS the
    // rail that gets them fulfilled. Closing one would break WebMCP rather
    // than protect anything.
    const result = await runTurn({
      messages: historyWithOpenCall("ui_open_panel"),
      tools: { ui_open_panel: clientFulfilledTool("ui_open_panel") },
    });
    expect(toolResultsFor(result.messageHistory, "call-1")).toHaveLength(0);
  });

  it("leaves a RESOLVED call alone", async () => {
    const messages = [
      ...historyWithOpenCall("charge_card"),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "charge_card",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ] as unknown as ModelMessage[];
    const result = await runTurn({
      messages,
      tools: { charge_card: runnableTool("charge_card") },
    });
    const results = toolResultsFor(result.messageHistory, "call-1");
    expect(results).toHaveLength(1);
    expect(isInterruptedToolResult(results[0])).toBe(false);
  });

  it("is a no-op on a history with nothing open", async () => {
    const before = [{ role: "user", content: "hi" }] as ModelMessage[];
    const result = await runTurn({ messages: before, tools: {} });
    expect(result.messageHistory.filter((m) => m.role === "tool")).toEqual([]);
  });
});
