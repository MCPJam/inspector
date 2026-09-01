/**
 * The approval controller: who decides, what the decision maps to, and the
 * rule that nothing may hang.
 *
 * Driven against a stub `BridgeTurn` and the real translator, so the ordering
 * guarantee (tool-call before tool-approval-request) is exercised rather than
 * assumed.
 */
import { describe, expect, it, vi } from "vitest";
import type { BridgeEvent, BridgeTurn } from "@ai-sdk/harness/bridge";
import { createApprovalController } from "../bridge/approval-controller.js";
import { createStreamTranslator } from "../bridge/stream-translator.js";
import { RELAY_MCP_SERVER_NAME } from "../shared/tool-names.js";

function harness(
  options: {
    approve?: boolean | (() => Promise<{ approved: boolean }>);
  } = {},
) {
  const parts: BridgeEvent[] = [];
  const warnings: string[] = [];
  const requested: string[] = [];

  const turn = {
    emit: (part: BridgeEvent) => parts.push(part),
    emitWarning: ({ message }: { message: string }) => warnings.push(message),
    emitError: vi.fn(),
    bridgeLog: vi.fn(),
    requestToolApproval: (approvalId: string) => {
      requested.push(approvalId);
      if (typeof options.approve === "function") return options.approve();
      return Promise.resolve({ approved: options.approve ?? true });
    },
    requestToolResult: vi.fn(),
    abortSignal: new AbortController().signal,
    firstTurn: true,
    experimental_userMessages: undefined,
  } as unknown as BridgeTurn;

  const translator = createStreamTranslator({
    emit: (part) => parts.push(part),
    emitWarning: ({ message }) => warnings.push(message),
    emitError: () => {},
    relayServerName: RELAY_MCP_SERVER_NAME,
    emitRaw: false,
  });
  const controller = createApprovalController({ turn, translator });
  return { controller, translator, parts, warnings, requested };
}

const commandApproval = (itemId = "call_1") => ({
  id: 7,
  method: "item/commandExecution/requestApproval",
  params: {
    threadId: "thr_1",
    turnId: "turn_1",
    itemId,
    startedAtMs: 1,
    command: "/bin/bash -lc 'echo hi > probe.txt'",
    cwd: "/w",
    commandActions: [{ type: "unknown", command: "echo hi > probe.txt" }],
  },
});

describe("command execution approvals", () => {
  it("emits the tool-call before the approval, from the approval's own params", async () => {
    // Codex sends the approval BEFORE `item/started`, so the call cannot be
    // built from the item. Everything the call needs is on the approval.
    const { controller, parts } = harness({ approve: true });
    await controller.handle(commandApproval());

    const types = parts.map((part) => part.type);
    expect(types).toEqual(["tool-call", "tool-approval-request"]);
    const call = parts[0] as Record<string, unknown>;
    expect(call.toolName).toBe("bash");
    expect(call.nativeName).toBe("exec_command");
    expect(call.providerExecuted).toBe(true);
    expect(JSON.parse(String(call.input))).toMatchObject({
      command: "/bin/bash -lc 'echo hi > probe.txt'",
      cwd: "/w",
    });
    expect((parts[1] as Record<string, unknown>).toolCallId).toBe(
      call.toolCallId,
    );
  });

  it("maps approval to accept and denial to decline", async () => {
    // `decline`, not `cancel`: cancel reads as "the user walked away", decline
    // as "the user said no", and only decline produces the `declined` item
    // status the trace should show. Verified live that Codex honours it even
    // when `availableDecisions` omits it.
    const approved = harness({ approve: true });
    expect(await approved.controller.handle(commandApproval())).toEqual({
      decision: "accept",
    });

    const denied = harness({ approve: false });
    expect(await denied.controller.handle(commandApproval())).toEqual({
      decision: "decline",
    });
  });

  it("mints its own approval id rather than trusting Codex's nullable one", async () => {
    const { controller, requested, parts } = harness();
    await controller.handle({
      ...commandApproval(),
      params: { ...commandApproval().params, approvalId: null },
    });
    expect(requested[0]).toMatch(/^codex-approval-\d+$/);
    const approval = parts.find((p) => p.type === "tool-approval-request");
    expect(approval?.approvalId).toBe(requested[0]);
  });

  it("does not emit a second tool-call when the item follows the approval", async () => {
    const { controller, translator, parts } = harness();
    await controller.handle(commandApproval("call_1"));
    translator.handleNotification({
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          id: "call_1",
          command: "/bin/bash -lc 'echo hi'",
          status: "inProgress",
        },
      },
    });
    expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
  });
});

describe("file change approvals", () => {
  it("pauses on a patch even though the approval carries no paths", async () => {
    // The paths arrive on the item, not the approval. Seeding with what IS
    // known is what lets the pause happen at all; the tool-result carries them.
    const { controller, parts } = harness({ approve: true });
    const decision = await controller.handle({
      id: 8,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "t",
        turnId: "u",
        itemId: "call_2",
        startedAtMs: 1,
        grantRoot: "/w",
      },
    });
    expect(decision).toEqual({ decision: "accept" });
    const call = parts.find((part) => part.type === "tool-call");
    expect(call?.toolName).toBe("fileChange");
    expect(call?.nativeName).toBe("apply_patch");
  });
});

describe("requests we answer without asking the user", () => {
  // Every one of these must produce an ANSWER: Codex blocks the turn on an
  // unanswered server request, so silence is a wedged sandbox.
  it("grants no permissions when Codex asks to widen them", async () => {
    const { controller, warnings } = harness();
    const result = await controller.handle({
      id: 9,
      method: "item/permissions/requestApproval",
      params: { threadId: "t", turnId: "u", itemId: "i", cwd: "/w" },
    });
    expect(result).toEqual({ permissions: [], scope: "turn" });
    expect(warnings.join(" ")).toContain("granted none");
  });

  it("answers a mid-turn question with no input, and says so", async () => {
    const { controller, warnings } = harness();
    const result = await controller.handle({
      id: 10,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "t",
        turnId: "u",
        itemId: "i",
        isBlocking: true,
        questions: [
          {
            id: "q1",
            header: "Which",
            question: "Which one?",
            isOther: false,
            isSecret: false,
          },
        ],
      },
    });
    expect(result).toEqual({ answers: {} });
    expect(warnings.join(" ")).toContain("Which one?");
  });

  it("declines an MCP elicitation", async () => {
    const { controller, warnings } = harness();
    expect(
      await controller.handle({
        id: 11,
        method: "mcpServer/elicitation/request",
        params: { threadId: "t", serverName: "github" },
      }),
    ).toEqual({ action: "decline", content: null });
    expect(warnings.join(" ")).toContain("declined");
  });

  it("throws for an unknown method, which is still an answer", async () => {
    // A JSON-RPC error tells Codex that request failed and lets it move on.
    // Returning nothing would leave it blocked forever.
    const { controller } = harness();
    await expect(
      controller.handle({ id: 12, method: "some/futureRequest", params: {} }),
    ).rejects.toThrow(/unsupported server request/);
  });
});

describe("cancellation", () => {
  it("resolves a waiting approval as cancel when the turn aborts", async () => {
    // A turn that aborts mid-approval must not leave Codex blocked on a human
    // who is never going to answer.
    const { controller } = harness({
      approve: () => new Promise(() => {}), // never settles
    });
    const pending = controller.handle(commandApproval());
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.cancelAll();
    expect(await pending).toEqual({ decision: "cancel" });
  });

  it("cancels immediately once cancelled, without prompting again", async () => {
    const { controller, requested } = harness();
    controller.cancelAll();
    expect(await controller.handle(commandApproval())).toEqual({
      decision: "cancel",
    });
    expect(requested).toHaveLength(0);
  });

  it("cancels rather than running unapproved work when the host errors", async () => {
    const { controller } = harness({
      approve: () => Promise.reject(new Error("socket gone")),
    });
    expect(await controller.handle(commandApproval())).toEqual({
      decision: "cancel",
    });
  });
});
