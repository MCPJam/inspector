/**
 * The evidence seam around a proxied `tools/call`.
 *
 * The bridge is where the completeness protocol's two hard rules are enforced,
 * and both are about ORDER:
 *
 *   1. Nothing reaches the user's server until the call's start is durably
 *      recorded. A call that executed without a record of having started is
 *      invisible loss — the turn would read as complete with that call simply
 *      missing, and a merger trusting it grades a real call as a hallucination.
 *   2. Nothing goes back to the harness until the outcome is durably recorded.
 *      A turn that ends normally therefore cannot have a settle still in
 *      flight.
 *
 * The third rule is about BLAME: an evidence-layer failure must never be
 * reported as the user's server failing. The two are opposite claims about
 * whether the tool ran.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVIDENCE_UNAVAILABLE_CODE,
  handleJsonRpc,
  type ToolCallEvidenceHook,
} from "../mcp-http-bridge";

function managerWith(
  executeTool: ReturnType<typeof vi.fn>,
  over: Record<string, unknown> = {},
) {
  return {
    getManagedClient: vi.fn().mockReturnValue(undefined),
    hasServer: vi.fn().mockReturnValue(false),
    listTools: vi.fn(),
    executeTool,
    readResource: vi.fn(),
    getPrompt: vi.fn(),
    ...over,
  } as any;
}

function recordingHook(over: Partial<ToolCallEvidenceHook> = {}): {
  hook: ToolCallEvidenceHook;
  order: string[];
} {
  const order: string[] = [];
  const hook: ToolCallEvidenceHook = {
    beforeExecute: async (context) => {
      order.push(`start:${context.serverId}:${context.toolName}`);
      return { ok: true };
    },
    afterExecute: async (context) => {
      order.push(`settle:${context.outcome.kind}`);
    },
    ...over,
  };
  return { hook, order };
}

const callBody = {
  id: 1,
  method: "tools/call",
  params: { name: "search", arguments: { q: "x" } },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ordering", () => {
  it("records the start before the server is called, and settles before responding", async () => {
    const order: string[] = [];
    const executeTool = vi.fn(async () => {
      order.push("execute");
      return { content: [{ type: "text", text: "ok" }] };
    });
    const hook: ToolCallEvidenceHook = {
      beforeExecute: async () => {
        order.push("start");
        return { ok: true };
      },
      afterExecute: async () => {
        order.push("settle");
      },
    };

    const response = await handleJsonRpc(
      "srv-1",
      callBody,
      managerWith(executeTool),
      "manager",
      { toolCallEvidence: hook },
    );

    expect(order).toEqual(["start", "execute", "settle"]);
    expect(response).toMatchObject({
      result: { content: [{ type: "text", text: "ok" }] },
    });
  });

  it("hands the hook the RESOLVED server and un-prefixed tool name", async () => {
    // A prefixed call reroutes; the evidence row is keyed on what actually
    // executed, not on what the harness typed. Recording the prefixed name
    // would make the row unmatchable against the narration.
    const executeTool = vi.fn(async () => ({ content: [] }));
    const { hook, order } = recordingHook();

    await handleJsonRpc(
      "srv-1",
      {
        id: 1,
        method: "tools/call",
        params: { name: "other:search", arguments: {} },
      },
      managerWith(executeTool, { hasServer: vi.fn().mockReturnValue(true) }),
      "manager",
      { toolCallEvidence: hook },
    );

    expect(order[0]).toBe("start:other:search");
    expect(executeTool).toHaveBeenCalledWith("other", "search", {});
  });
});

describe("a start that does not land", () => {
  it("does NOT call the user's server, and says so in its own error code", async () => {
    const executeTool = vi.fn();
    const response = await handleJsonRpc(
      "srv-1",
      callBody,
      managerWith(executeTool),
      "manager",
      {
        toolCallEvidence: {
          beforeExecute: async () => ({
            ok: false,
            reason: "evidence sink down",
          }),
          afterExecute: async () => {},
        },
      },
    );

    expect(executeTool).not.toHaveBeenCalled();
    // -32001, not the -32000 an upstream tool failure uses: "it never ran" and
    // "it ran and failed" are opposite claims about the user's server.
    expect(response).toMatchObject({
      error: { code: EVIDENCE_UNAVAILABLE_CODE, message: "evidence sink down" },
    });
  });

  it("treats a THROWN hook the same way, never as an upstream failure", async () => {
    // The hazard this guards: the hook is awaited inside the same try block
    // whose catch produces -32000, so a rejection would otherwise be reported
    // as the server having failed a call it never received.
    const executeTool = vi.fn();
    const response = await handleJsonRpc(
      "srv-1",
      callBody,
      managerWith(executeTool),
      "manager",
      {
        toolCallEvidence: {
          beforeExecute: async () => {
            throw new Error("hook exploded");
          },
          afterExecute: async () => {},
        },
      },
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect((response as any).error.code).toBe(EVIDENCE_UNAVAILABLE_CODE);
    // Never leaks the internal failure as the tool's error text.
    expect((response as any).error.message).not.toContain("hook exploded");
    expect((response as any).error.message).toMatch(/not executed/i);
  });

  it("refuses in manager mode too, rather than an isError success envelope", async () => {
    // Manager mode answers upstream failures with a SUCCESS envelope carrying
    // `isError: true`. A call that never ran must not be dressed as a tool
    // that ran and returned an error.
    const response = await handleJsonRpc(
      "srv-1",
      callBody,
      managerWith(vi.fn()),
      "manager",
      {
        toolCallEvidence: {
          beforeExecute: async () => ({ ok: false, reason: "no" }),
          afterExecute: async () => {},
        },
      },
    );

    expect(response).not.toHaveProperty("result");
    expect((response as any).error.code).toBe(EVIDENCE_UNAVAILABLE_CODE);
  });
});

describe("settlement", () => {
  it("settles a FAILED call before the failure is shaped for the harness", async () => {
    // The wire record of a call the model was told failed is the one a reader
    // most wants; losing it because the call threw would be backwards.
    const order: string[] = [];
    const executeTool = vi.fn(async () => {
      order.push("execute");
      throw new Error("tool blew up");
    });
    const hook: ToolCallEvidenceHook = {
      beforeExecute: async () => {
        order.push("start");
        return { ok: true };
      },
      afterExecute: async (context) => {
        order.push(`settle:${context.outcome.kind}`);
      },
    };

    const response = await handleJsonRpc(
      "srv-1",
      callBody,
      managerWith(executeTool),
      "manager",
      { toolCallEvidence: hook },
    );

    // MANAGER mode answers a thrown failure as a SUCCESS envelope carrying
    // an `isError: true` CallToolResult — so that is what settles: the
    // outcome the harness actually sees, not the exception behind it. (The
    // adapter path settles `kind: "error"` with the exact JSON-RPC envelope —
    // see "the recorded error is the wire error" below.)
    expect(order).toEqual(["start", "execute", "settle:result"]);
    // The response is unchanged from a run with no evidence hook at all.
    expect(response).toMatchObject({
      result: {
        content: [{ type: "text", text: "Error: tool blew up" }],
        isError: true,
      },
    });
  });

  it("classifies an isError RESULT as a result, not an error", async () => {
    // `isError: true` is a domain answer the model reads and reacts to. The
    // bridge never saw a failure, and the evidence must not invent one.
    const executeTool = vi.fn(async () => ({
      content: [{ type: "text", text: "no such row" }],
      isError: true,
    }));
    const seen: string[] = [];

    await handleJsonRpc(
      "srv-1",
      callBody,
      managerWith(executeTool),
      "manager",
      {
        toolCallEvidence: {
          beforeExecute: async () => ({ ok: true }),
          afterExecute: async (context) => {
            seen.push(context.outcome.kind);
            if (context.outcome.kind === "result") {
              seen.push(JSON.stringify(context.outcome.result));
            }
          },
        },
      },
    );

    expect(seen[0]).toBe("result");
    expect(seen[1]).toContain('"isError":true');
  });

  it("a failed settle changes NOTHING about the result the harness gets", async () => {
    // The call already happened; its side effects are real whether or not the
    // record landed. The loss rides on the unsettled row instead.
    const executeTool = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const response = await handleJsonRpc(
      "srv-1",
      callBody,
      managerWith(executeTool),
      "manager",
      {
        toolCallEvidence: {
          beforeExecute: async () => ({ ok: true }),
          afterExecute: async () => {
            throw new Error("settle exhausted");
          },
        },
      },
    );

    expect(response).toMatchObject({
      result: { content: [{ type: "text", text: "ok" }] },
    });
  });
});

describe("with no hook", () => {
  it("is byte-identical to the pre-evidence path", async () => {
    const executeTool = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const withoutHook = await handleJsonRpc(
      "srv-1",
      callBody,
      managerWith(executeTool),
      "manager",
    );
    const withInertHook = await handleJsonRpc(
      "srv-1",
      callBody,
      managerWith(executeTool),
      "manager",
      {},
    );

    expect(withoutHook).toEqual(withInertHook);
    expect(withoutHook).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "ok" }] },
    });
  });
});

describe("the recorded error is the wire error", () => {
  it("hands afterExecute the EXACT envelope the adapter response carries", async () => {
    const boom = Object.assign(new Error("upstream exploded"), {
      code: -32050,
    });
    const executeTool = vi.fn(async () => {
      throw boom;
    });
    const settled: unknown[] = [];
    const hook: ToolCallEvidenceHook = {
      beforeExecute: async () => ({ ok: true }),
      afterExecute: async (context) => {
        settled.push(context.outcome);
      },
    };

    const response = await handleJsonRpc(
      "server-1",
      callBody,
      managerWith(executeTool),
      "adapter",
      { toolCallEvidence: hook },
    );

    expect(settled).toHaveLength(1);
    const outcome = settled[0] as {
      kind: string;
      errorEnvelope: { code: number; message: string; data?: unknown };
    };
    expect(outcome.kind).toBe("error");
    // Byte-for-byte the response's error member — message fallback chain,
    // `data.normalized` and all. A reconstruction would drift the moment the
    // bridge's catch evolves, and failed calls are exactly the rows a reader
    // most needs the wire record of.
    expect(outcome.errorEnvelope).toEqual(response.error);
    expect(outcome.errorEnvelope.data).toHaveProperty("normalized");
  });

  it("in manager mode records the isError RESULT the harness actually sees", async () => {
    const executeTool = vi.fn(async () => {
      throw new Error("upstream exploded");
    });
    const settled: unknown[] = [];
    const hook: ToolCallEvidenceHook = {
      beforeExecute: async () => ({ ok: true }),
      afterExecute: async (context) => {
        settled.push(context.outcome);
      },
    };

    const response = await handleJsonRpc(
      "server-1",
      callBody,
      managerWith(executeTool),
      "manager",
      { toolCallEvidence: hook },
    );

    // Manager mode answers a thrown failure as a SUCCESS envelope carrying an
    // `isError: true` CallToolResult — which is what the model reads, so it is
    // what the evidence records (outcome kind `call_tool_error` downstream).
    const outcome = settled[0] as { kind: string; result: unknown };
    expect(outcome.kind).toBe("result");
    expect(outcome.result).toEqual(response.result);
    expect(outcome.result).toMatchObject({ isError: true });
  });

  it("an error BEFORE the start settles nothing", async () => {
    const executeTool = vi.fn();
    const { hook, order } = recordingHook();

    // No tool name: the throw happens before the evidence seam is reached.
    await handleJsonRpc(
      "server-1",
      { id: 1, method: "tools/call", params: { arguments: {} } },
      managerWith(executeTool),
      "adapter",
      { toolCallEvidence: hook },
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });
});
