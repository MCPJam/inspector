/**
 * The `input_required` driver (`src/mcp-client-manager/task-input-driver.ts`).
 *
 * The property under test throughout: a task's input channel is not more
 * trusted than a direct server→client request. Everything the standalone path
 * would refuse — an undeclared capability, an unrenderable elicitation mode,
 * content that fails its own `requestedSchema` — is refused here too, and
 * refused *visibly* rather than being silently marked handled.
 */

import { describe, expect, it, vi } from "vitest";
import {
  canDeclareTasksExtension,
  collectTaskInputResponses,
  readDeclaredInputCapabilities,
  type TaskInputHandlers,
} from "../src/mcp-client-manager/task-input-driver.js";
import type { ClientCapabilityOptions } from "../src/mcp-client-manager/types.js";

const ALL_CAPS = {
  elicitation: {},
  roots: {},
  sampling: {},
} as ClientCapabilityOptions;

function handlers(overrides: Partial<TaskInputHandlers> = {}): TaskInputHandlers {
  return {
    elicitation: async () => ({ action: "accept", content: {} }),
    roots: async () => ({ roots: [] }),
    sampling: async () => ({
      role: "assistant",
      content: { type: "text", text: "ok" },
      model: "test",
    }),
    ...overrides,
  };
}

const collect = (args: {
  inputRequests: Record<string, unknown>;
  declaredCapabilities?: ClientCapabilityOptions;
  handlers?: TaskInputHandlers;
  respondedKeys?: Set<string>;
  validateElicitationContent?: (
    schema: unknown,
    content: unknown
  ) => { valid: boolean; error?: string };
  limits?: { maxRequests?: number; maxResponsesPerUpdate?: number };
}) =>
  collectTaskInputResponses({
    options: {
      declaredCapabilities: args.declaredCapabilities ?? ALL_CAPS,
      handlers: args.handlers ?? handlers(),
      validateElicitationContent: args.validateElicitationContent,
      limits: args.limits,
    },
    taskId: "task-1",
    serverId: "srv",
    inputRequests: args.inputRequests as never,
    respondedKeys: args.respondedKeys,
  });

describe("all three extension input methods", () => {
  it("routes elicitation, roots, and sampling through their declared handlers", async () => {
    const seen: string[] = [];
    const result = await collect({
      inputRequests: {
        e: { method: "elicitation/create", params: { message: "hi" } },
        r: { method: "roots/list" },
        s: { method: "sampling/createMessage", params: { messages: [] } },
      },
      handlers: handlers({
        elicitation: async () => {
          seen.push("elicitation");
          return { action: "accept", content: {} };
        },
        roots: async () => {
          seen.push("roots");
          return { roots: [] };
        },
        sampling: async () => {
          seen.push("sampling");
          return { role: "assistant", content: { type: "text", text: "" }, model: "m" };
        },
      }),
    });

    expect(seen.sort()).toEqual(["elicitation", "roots", "sampling"]);
    expect(result.answeredKeys.sort()).toEqual(["e", "r", "s"]);
    expect(result.rejections).toEqual([]);
  });

  it("passes the task and key context to the handler, so a handler can attribute the prompt", async () => {
    const spy = vi.fn(async () => ({ action: "accept", content: {} }));
    await collect({
      inputRequests: { k: { method: "elicitation/create", params: {} } },
      handlers: handlers({ elicitation: spy }),
    });
    expect(spy).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ taskId: "task-1", serverId: "srv", inputKey: "k" })
    );
  });
});

describe("trust rules match the standalone path", () => {
  it("refuses a method the client never declared, and says so", async () => {
    const result = await collect({
      inputRequests: { s: { method: "sampling/createMessage" } },
      declaredCapabilities: { elicitation: {} } as ClientCapabilityOptions,
    });

    expect(result.answeredKeys).toEqual([]);
    expect(result.rejections).toEqual([
      expect.objectContaining({
        inputKey: "s",
        method: "sampling/createMessage",
        reason: "undeclared-capability",
      }),
    ]);
  });

  it("distinguishes 'we never declared it' from 'we declared it and forgot the handler'", async () => {
    const result = await collect({
      inputRequests: { r: { method: "roots/list" } },
      declaredCapabilities: ALL_CAPS,
      handlers: handlers({ roots: undefined }),
    });
    expect(result.rejections[0]).toMatchObject({ reason: "no-handler" });
  });

  it("refuses an elicitation mode this client cannot render", async () => {
    const result = await collect({
      inputRequests: {
        k: { method: "elicitation/create", params: { mode: "telepathy" } },
      },
    });
    expect(result.rejections[0]).toMatchObject({
      reason: "unsupported-elicitation-mode",
    });
  });

  it("validates accepted elicitation content against its own requestedSchema", async () => {
    const result = await collect({
      inputRequests: {
        k: {
          method: "elicitation/create",
          params: { requestedSchema: { type: "object" } },
        },
      },
      handlers: handlers({
        elicitation: async () => ({ action: "accept", content: { bad: 1 } }),
      }),
      validateElicitationContent: () => ({ valid: false, error: "nope" }),
    });
    expect(result.answeredKeys).toEqual([]);
    expect(result.rejections[0]).toMatchObject({ reason: "malformed-request" });
  });

  it("does not schema-check a decline — a decline is a response, not content", async () => {
    const validate = vi.fn(() => ({ valid: false, error: "unreachable" }));
    const result = await collect({
      inputRequests: {
        k: {
          method: "elicitation/create",
          params: { requestedSchema: { type: "object" } },
        },
      },
      handlers: handlers({ elicitation: async () => ({ action: "decline" }) }),
      validateElicitationContent: validate,
    });
    expect(validate).not.toHaveBeenCalled();
    expect(result.answeredKeys).toEqual(["k"]);
  });

  it("rejects an unrecognized method rather than forwarding it", async () => {
    const result = await collect({
      inputRequests: { k: { method: "tools/call" } },
    });
    expect(result.rejections[0]).toMatchObject({
      reason: "unsupported-method",
      method: "tools/call",
    });
  });
});

describe("partial answering", () => {
  it("answers what it can and keeps the rest visible — one bad key never stalls the task", async () => {
    const result = await collect({
      inputRequests: {
        ok: { method: "elicitation/create", params: {} },
        bad: { method: "sampling/createMessage" },
      },
      declaredCapabilities: { elicitation: {} } as ClientCapabilityOptions,
    });

    expect(result.answeredKeys).toEqual(["ok"]);
    expect(Object.keys(result.responses)).toEqual(["ok"]);
    expect(result.rejections).toHaveLength(1);
  });

  it("never re-prompts a key an earlier update already acknowledged", async () => {
    const spy = vi.fn(async () => ({ action: "accept", content: {} }));
    const result = await collect({
      inputRequests: {
        done: { method: "elicitation/create", params: {} },
        fresh: { method: "elicitation/create", params: {} },
      },
      handlers: handlers({ elicitation: spy }),
      respondedKeys: new Set(["done"]),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.answeredKeys).toEqual(["fresh"]);
    expect(result.alreadyAnsweredKeys).toEqual(["done"]);
  });

  it("surfaces a throwing handler as a rejection instead of failing the whole round", async () => {
    const result = await collect({
      inputRequests: {
        boom: { method: "elicitation/create", params: {} },
        fine: { method: "roots/list" },
      },
      handlers: handlers({
        elicitation: async () => {
          throw new Error("user closed the dialog");
        },
      }),
    });
    expect(result.answeredKeys).toEqual(["fine"]);
    expect(result.rejections[0]).toMatchObject({
      reason: "handler-failed",
      message: "user closed the dialog",
    });
  });
});

describe("hostile input", () => {
  it("treats a prototype-polluting key as an ordinary key", async () => {
    const result = await collect({
      inputRequests: JSON.parse(
        '{"__proto__":{"method":"elicitation/create"},"constructor":{"method":"roots/list"}}'
      ),
    });
    // Both are answered as data. Nothing on Object.prototype was touched.
    expect(result.answeredKeys.sort()).toEqual(["__proto__", "constructor"]);
    expect(({} as Record<string, unknown>).method).toBeUndefined();
  });

  it("caps the number of requests it will process and reports the overflow", async () => {
    const inputRequests: Record<string, unknown> = {};
    for (let i = 0; i < 10; i += 1) {
      inputRequests[`k${i}`] = { method: "elicitation/create", params: {} };
    }
    const result = await collect({ inputRequests, limits: { maxRequests: 3 } });

    expect(result.answeredKeys).toHaveLength(3);
    // The dropped keys are REPORTED, never silently discarded.
    expect(result.rejections).toHaveLength(7);
    expect(result.rejections.every((r) => r.reason === "limit-exceeded")).toBe(true);
  });

  it("stops at the per-update response cap and leaves the remainder for a later round", async () => {
    const inputRequests: Record<string, unknown> = {};
    for (let i = 0; i < 5; i += 1) {
      inputRequests[`k${i}`] = { method: "elicitation/create", params: {} };
    }
    const result = await collect({
      inputRequests,
      limits: { maxResponsesPerUpdate: 2 },
    });
    expect(result.answeredKeys).toHaveLength(2);
    expect(result.rejections).toEqual([]);
  });

  it("rejects a non-object request entry", async () => {
    const result = await collect({ inputRequests: { k: "not-an-object" } });
    expect(result.rejections[0]).toMatchObject({ reason: "malformed-request" });
  });
});

describe("declaration eligibility", () => {
  it("reads declared capabilities off the exact object handed to the client", () => {
    expect(readDeclaredInputCapabilities(ALL_CAPS)).toEqual({
      elicitation: true,
      roots: true,
      sampling: true,
    });
    expect(readDeclaredInputCapabilities(undefined)).toEqual({
      elicitation: false,
      roots: false,
      sampling: false,
    });
    // A non-object capability value is not a declaration.
    expect(
      readDeclaredInputCapabilities({ elicitation: true } as never).elicitation
    ).toBe(false);
  });

  it("refuses to let a surface declare tasks when a declared capability has no handler", () => {
    expect(canDeclareTasksExtension(ALL_CAPS, handlers())).toEqual({ ok: true });
    expect(
      canDeclareTasksExtension(ALL_CAPS, handlers({ sampling: undefined }))
    ).toEqual({ ok: false, missing: ["sampling/createMessage"] });
  });

  it("allows declaring tasks when a capability is absent AND unhandled — nothing to strand", () => {
    expect(
      canDeclareTasksExtension({ elicitation: {} } as ClientCapabilityOptions, {
        elicitation: async () => ({ action: "cancel" }),
      })
    ).toEqual({ ok: true });
  });
});

describe("abort during collection", () => {
  it("stops without recording handler-failed for the aborted prompt", async () => {
    // The abort tears down an open prompt (its throw is a consequence of the
    // signal, not a failed handler) and the remaining keys must not be
    // prompted into a dead terminal.
    const controller = new AbortController();
    const prompted: string[] = [];
    const result = await collectTaskInputResponses({
      options: {
        declaredCapabilities: { elicitation: {} } as ClientCapabilityOptions,
        handlers: {
          elicitation: async (params) => {
            prompted.push(String((params as { key?: unknown }).key ?? "?"));
            controller.abort();
            throw new Error("prompt torn down by abort");
          },
        },
      },
      taskId: "task-1",
      serverId: "srv",
      inputRequests: {
        a: { method: "elicitation/create", params: { key: "a" } },
        b: { method: "elicitation/create", params: { key: "b" } },
      } as never,
      signal: controller.signal,
    });
    expect(prompted).toEqual(["a"]);
    expect(result.answeredKeys).toEqual([]);
    expect(result.rejections).toEqual([]);
  });
});
