import { describe, expect, it, vi } from "vitest";
import {
  DialectAwareJsonSchemaValidator,
} from "../src/mcp-client-manager/dialect-aware-json-schema-validator.js";
import type { JsonSchemaType } from "@modelcontextprotocol/client";
import {
  DEFAULT_MAX_MRTR_ROUNDS,
  executeInputRequiredLeg,
  initInputRequiredState,
  isMaxRoundsExceeded,
  makeRequestWithSchemaLegSender,
  MrtrInputValidationError,
  MrtrUndeclaredInputError,
  MrtrUnsupportedElicitationModeError,
  resumeInputRequiredOperation,
  runInputRequiredOperation,
  validateInputRequests,
  type ElicitationContentValidator,
  type InputRequiredResult,
  type MrtrLegSender,
  type MrtrMethod,
} from "../src/mcp-client-manager/mrtr-driver.js";

/**
 * Driver-level coverage of the manual multi-round-trip (`input_required`) loop
 * (spec §12). The wire is a scripted {@link MrtrLegSender} so every §12 case —
 * round replacement, hostile keys, undeclared methods/modes, self-validation,
 * abort, the MCPJam-owned round cap — is exercised deterministically against
 * the real driver code, independent of any transport.
 */

// A form-mode elicitation request the client CAN fulfil.
function formElicit(message: string): InputRequiredResult["inputRequests"][string] {
  return {
    method: "elicitation/create",
    params: {
      message,
      requestedSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    },
  } as InputRequiredResult["inputRequests"][string];
}

function inputRequired(
  inputRequests: Record<string, unknown> | undefined,
  requestState?: string,
): InputRequiredResult {
  return {
    resultType: "input_required",
    ...(inputRequests ? { inputRequests } : {}),
    ...(requestState !== undefined ? { requestState } : {}),
  } as InputRequiredResult;
}

/**
 * A scripted sender: returns queued results in order, recording every request
 * it was asked to send (so tests can assert param construction across rounds).
 */
function scriptedSender(script: unknown[]): {
  sender: MrtrLegSender;
  requests: Array<{ method: MrtrMethod; params: Record<string, unknown> }>;
} {
  const requests: Array<{ method: MrtrMethod; params: Record<string, unknown> }> =
    [];
  let i = 0;
  const sender: MrtrLegSender = async (request) => {
    requests.push({ method: request.method, params: request.params });
    if (i >= script.length) {
      throw new Error(`scripted sender exhausted after ${script.length} legs`);
    }
    return script[i++] as never;
  };
  return { sender, requests };
}

const acceptAnswer = { action: "accept", content: { answer: "yes" } };

describe("executeInputRequiredLeg — classification", () => {
  it("returns complete when the first result is not input_required", async () => {
    const { sender } = scriptedSender([{ content: [{ type: "text", text: "ok" }] }]);
    const state = initInputRequiredState({
      method: "tools/call",
      params: { name: "t", arguments: { a: 1 } },
    });
    const leg = await executeInputRequiredLeg({ sender, state });
    expect(leg.status).toBe("complete");
    if (leg.status === "complete") {
      expect(leg.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    }
  });

  it("surfaces a single form round with its pending requests + requestState", async () => {
    const { sender } = scriptedSender([
      inputRequired({ q: formElicit("Continue?") }, "state-token-1"),
    ]);
    const state = initInputRequiredState({
      method: "tools/call",
      params: { name: "t" },
    });
    const leg = await executeInputRequiredLeg({ sender, state });
    expect(leg.status).toBe("input_required");
    if (leg.status === "input_required") {
      expect(leg.state.round).toBe(1);
      expect(Object.keys(leg.state.pendingInputRequests)).toEqual(["q"]);
      expect(leg.state.requestState).toBe("state-token-1");
    }
  });
});

describe("per-round replacement + requestState echo", () => {
  it("echoes requestState verbatim and sends this round's responses only", async () => {
    const { sender, requests } = scriptedSender([
      inputRequired({ q: formElicit("r1") }, "S1"),
      inputRequired({ q: formElicit("r2") }, "S2"),
      { content: [{ type: "text", text: "done" }] },
    ]);
    const collectInput = vi.fn().mockResolvedValue({ q: acceptAnswer });
    const result = await runInputRequiredOperation({
      method: "tools/call",
      params: { name: "t", arguments: { a: 1 } },
      sender,
      collectInput,
    });
    expect(result).toEqual({ content: [{ type: "text", text: "done" }] });
    // Round 0 (initial): only original params.
    expect(requests[0].params).toEqual({ name: "t", arguments: { a: 1 } });
    // Round 1 retry: original params + this round's responses + echoed S1.
    expect(requests[1].params).toEqual({
      name: "t",
      arguments: { a: 1 },
      inputResponses: { q: acceptAnswer },
      requestState: "S1",
    });
    // Round 2 retry: responses REPLACED (not accumulated), state echoes S2.
    expect(requests[2].params).toEqual({
      name: "t",
      arguments: { a: 1 },
      inputResponses: { q: acceptAnswer },
      requestState: "S2",
    });
    // Original params object is never mutated across rounds.
    expect(requests[0].params.arguments).toEqual({ a: 1 });
  });

  it("supports a state-only round (no inputRequests): immediate retry with just requestState", async () => {
    const { sender, requests } = scriptedSender([
      inputRequired(undefined, "ONLY-STATE"),
      { content: [{ type: "text", text: "done" }] },
    ]);
    const collectInput = vi.fn().mockResolvedValue({});
    const result = await runInputRequiredOperation({
      method: "resources/read",
      params: { uri: "res://x" },
      sender,
      collectInput,
    });
    expect(result).toEqual({ content: [{ type: "text", text: "done" }] });
    // The retry carries requestState but NO inputResponses.
    expect(requests[1].params).toEqual({ uri: "res://x", requestState: "ONLY-STATE" });
    expect("inputResponses" in requests[1].params).toBe(false);
  });

  it("supports an inputs-without-state round (no requestState)", async () => {
    const { sender, requests } = scriptedSender([
      inputRequired({ q: formElicit("r1") }),
      { messages: [] },
    ]);
    const collectInput = vi.fn().mockResolvedValue({ q: acceptAnswer });
    await runInputRequiredOperation({
      method: "prompts/get",
      params: { name: "p" },
      sender,
      collectInput,
    });
    expect(requests[1].params).toEqual({
      name: "p",
      inputResponses: { q: acceptAnswer },
    });
    expect("requestState" in requests[1].params).toBe(false);
  });
});

describe("multi-input within one round", () => {
  it("collects every key and sends the whole current-round map together", async () => {
    const { sender, requests } = scriptedSender([
      inputRequired({ a: formElicit("A?"), b: formElicit("B?") }, "S"),
      { content: [] },
    ]);
    const collectInput = vi.fn(async ({ inputRequests }) => {
      // The UI is handed both keys at once.
      expect(Object.keys(inputRequests).sort()).toEqual(["a", "b"]);
      return {
        a: { action: "accept", content: { answer: "1" } },
        b: { action: "accept", content: { answer: "2" } },
      };
    });
    await runInputRequiredOperation({
      method: "tools/call",
      params: { name: "t" },
      sender,
      collectInput,
    });
    expect(requests[1].params.inputResponses).toEqual({
      a: { action: "accept", content: { answer: "1" } },
      b: { action: "accept", content: { answer: "2" } },
    });
  });

  it("rejects a mixed supported+unsupported round BEFORE any UI is shown", async () => {
    const { sender } = scriptedSender([
      inputRequired({
        ok: formElicit("A?"),
        bad: { method: "sampling/createMessage", params: {} },
      }),
    ]);
    const collectInput = vi.fn();
    await expect(
      runInputRequiredOperation({
        method: "tools/call",
        params: { name: "t" },
        sender,
        collectInput,
      }),
    ).rejects.toBeInstanceOf(MrtrUndeclaredInputError);
    expect(collectInput).not.toHaveBeenCalled();
  });
});

describe("undeclared methods and modes (Decision 8)", () => {
  it.each(["roots/list", "sampling/createMessage"])(
    "rejects embedded %s at the result, not via a request handler",
    async (method) => {
      const { sender } = scriptedSender([
        inputRequired({ k: { method, params: {} } }),
      ]);
      await expect(
        runInputRequiredOperation({
          method: "tools/call",
          params: { name: "t" },
          sender,
          collectInput: vi.fn(),
        }),
      ).rejects.toBeInstanceOf(MrtrUndeclaredInputError);
    },
  );

  it("rejects an undeclared elicitation mode", async () => {
    const { sender } = scriptedSender([
      inputRequired({
        k: { method: "elicitation/create", params: { message: "m", mode: "voice" } },
      }),
    ]);
    await expect(
      runInputRequiredOperation({
        method: "tools/call",
        params: { name: "t" },
        sender,
        collectInput: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(MrtrUnsupportedElicitationModeError);
  });

  it("accepts url mode and absent mode (defaults to form)", () => {
    expect(() =>
      validateInputRequests({
        u: { method: "elicitation/create", params: { message: "m", mode: "url", url: "https://x" } },
        f: formElicit("m"),
      } as never),
    ).not.toThrow();
  });
});

describe("hostile / prototype-polluting server keys", () => {
  it("keeps __proto__ / constructor as plain own keys and never pollutes Object.prototype", async () => {
    // Build the map the way a transport's JSON.parse would deliver a hostile
    // payload: genuine OWN "__proto__" / "constructor" keys (an object literal
    // `{ __proto__: ... }` would set the prototype, not an own key).
    const hostile = JSON.parse(
      JSON.stringify({
        __proto__: formElicit("evil"),
        constructor: formElicit("evil2"),
        safe: formElicit("ok"),
      }),
    ) as Record<string, unknown>;
    // Re-attach the two special keys as own props (JSON.stringify drops a
    // literal `__proto__`); this mirrors `JSON.parse('{"__proto__": …}')`.
    Object.defineProperty(hostile, "__proto__", {
      value: formElicit("evil"),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const { sender, requests } = scriptedSender([
      inputRequired(hostile, "S"),
      { content: [] },
    ]);
    const seenKeys: string[] = [];
    const collectInput = vi.fn(async ({ inputRequests }) => {
      seenKeys.push(...Object.keys(inputRequests));
      const out: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(inputRequests)) {
        out[key] = { action: "accept", content: { answer: "x" } };
      }
      return out;
    });
    await runInputRequiredOperation({
      method: "tools/call",
      params: { name: "t" },
      sender,
      collectInput,
    });
    expect(seenKeys.sort()).toEqual(["__proto__", "constructor", "safe"]);
    // No prototype pollution leaked anywhere.
    expect(({} as Record<string, unknown>).answer).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("answer");
    // The response map that went out carries the hostile keys as own props.
    const sent = requests[1].params.inputResponses as Record<string, unknown>;
    expect(Object.getPrototypeOf(sent)).toBeNull();
  });
});

describe("self-validation of accepted content (§12.1.11)", () => {
  const strictValidator: ElicitationContentValidator = (requestedSchema, content) => {
    const strict = new DialectAwareJsonSchemaValidator({
      onUnknownDialect: (d) => {
        throw new Error(`unsupported dialect ${d}`);
      },
    });
    const validate = strict.getValidator(requestedSchema as JsonSchemaType);
    const r = validate(content);
    return { valid: r.valid, error: r.errorMessage };
  };

  it("rejects accepted content that violates requestedSchema", async () => {
    const { sender } = scriptedSender([inputRequired({ q: formElicit("m") }, "S")]);
    await expect(
      runInputRequiredOperation({
        method: "tools/call",
        params: { name: "t" },
        sender,
        // `answer` is required + must be a string; number fails.
        collectInput: async () => ({ q: { action: "accept", content: { answer: 5 } } }),
        validateContent: strictValidator,
      }),
    ).rejects.toBeInstanceOf(MrtrInputValidationError);
  });

  it("does not validate content for a declined response", async () => {
    const { sender, requests } = scriptedSender([
      inputRequired({ q: formElicit("m") }, "S"),
      { content: [{ type: "text", text: "declined-path" }] },
    ]);
    const result = await runInputRequiredOperation({
      method: "tools/call",
      params: { name: "t" },
      sender,
      collectInput: async () => ({ q: { action: "decline" } }),
      validateContent: strictValidator,
    });
    // Decline is a RESPONSE, not an error — the retry carries it and the server
    // decides what to do.
    expect(result).toEqual({ content: [{ type: "text", text: "declined-path" }] });
    expect(requests[1].params.inputResponses).toEqual({ q: { action: "decline" } });
  });

  it("accepts cancel as a response too", async () => {
    const { sender, requests } = scriptedSender([
      inputRequired({ q: formElicit("m") }, "S"),
      { content: [] },
    ]);
    await runInputRequiredOperation({
      method: "tools/call",
      params: { name: "t" },
      sender,
      collectInput: async () => ({ q: { action: "cancel" } }),
      validateContent: strictValidator,
    });
    expect(requests[1].params.inputResponses).toEqual({ q: { action: "cancel" } });
  });
});

describe("MCPJam-owned round cap", () => {
  it("throws the upstream InputRequiredRoundsExceeded shape after maxRounds retries", async () => {
    // Always input_required: never completes.
    const script = Array.from({ length: 20 }, () => inputRequired({ q: formElicit("m") }, "S"));
    const { sender, requests } = scriptedSender(script);
    let error: unknown;
    await runInputRequiredOperation({
      method: "tools/call",
      params: { name: "t" },
      sender,
      collectInput: async () => ({ q: acceptAnswer }),
      maxRounds: 3,
    }).catch((e) => {
      error = e;
    });
    expect(isMaxRoundsExceeded(error)).toBe(true);
    expect((error as { data?: { rounds?: number } }).data?.rounds).toBe(3);
    // initial send + 3 retries = 4 wire legs before the cap fires.
    expect(requests.length).toBe(4);
  });

  it("defaults to DEFAULT_MAX_MRTR_ROUNDS", () => {
    const state = initInputRequiredState({ method: "tools/call", params: {} });
    expect(state.maxRounds).toBe(DEFAULT_MAX_MRTR_ROUNDS);
  });
});

describe("abort windows", () => {
  it("propagates an abort during the wire leg (never converts to decline)", async () => {
    const controller = new AbortController();
    const sender: MrtrLegSender = async (_req, ctx) => {
      controller.abort();
      const err = new Error("aborted");
      err.name = "AbortError";
      if (ctx.signal?.aborted) throw err;
      throw err;
    };
    await expect(
      runInputRequiredOperation({
        method: "tools/call",
        params: { name: "t" },
        sender,
        collectInput: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("propagates an abort while pending (collectInput rejects)", async () => {
    const controller = new AbortController();
    const { sender } = scriptedSender([inputRequired({ q: formElicit("m") }, "S")]);
    const collectInput = vi.fn(async () => {
      controller.abort();
      const err = new Error("user aborted");
      err.name = "AbortError";
      throw err;
    });
    await expect(
      runInputRequiredOperation({
        method: "tools/call",
        params: { name: "t" },
        sender,
        collectInput,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("entry methods + original params + resume", () => {
  it.each<MrtrMethod>(["tools/call", "prompts/get", "resources/read"])(
    "drives a single round for %s preserving original params",
    async (method) => {
      const originalParams =
        method === "resources/read"
          ? { uri: "res://x" }
          : { name: "entry", arguments: { k: "v" } };
      const { sender, requests } = scriptedSender([
        inputRequired({ q: formElicit("m") }, "S"),
        { ok: true },
      ]);
      await runInputRequiredOperation({
        method,
        params: originalParams,
        sender,
        collectInput: async () => ({ q: acceptAnswer }),
      });
      // Every leg carries the exact original params (plus round extras).
      for (const req of requests) {
        expect(req.method).toBe(method);
        for (const [k, v] of Object.entries(originalParams)) {
          expect(req.params[k]).toEqual(v);
        }
      }
    },
  );

  it("resumeInputRequiredOperation runs one retry leg from a suspended state", async () => {
    // Simulate a hosted round-trip: step once, persist state, resume.
    const { sender } = scriptedSender([
      inputRequired({ q: formElicit("m") }, "S"),
      { content: [{ type: "text", text: "resumed" }] },
    ]);
    const state = initInputRequiredState({ method: "tools/call", params: { name: "t" } });
    const first = await executeInputRequiredLeg({ sender, state });
    expect(first.status).toBe("input_required");
    if (first.status !== "input_required") return;

    // A different worker would rebuild the client; here `sender` closes over the
    // same script. Resume with a custom sender (client unused).
    const resumed = await resumeInputRequiredOperation(
      { requestWithSchema: (() => {}) as never },
      first.state,
      { q: acceptAnswer },
      { sender },
    );
    expect(resumed.status).toBe("complete");
    if (resumed.status === "complete") {
      expect(resumed.result).toEqual({ content: [{ type: "text", text: "resumed" }] });
    }
  });
});

describe("makeRequestWithSchemaLegSender", () => {
  it("calls requestWithSchema with allowInputRequired + the wrapped schema", async () => {
    const requestWithSchema = vi.fn().mockResolvedValue({ ok: true });
    const sender = makeRequestWithSchemaLegSender({ requestWithSchema });
    const signal = new AbortController().signal;
    await sender({ method: "tools/call", params: { name: "t" } }, { round: 0, signal });
    expect(requestWithSchema).toHaveBeenCalledTimes(1);
    const [req, schema, options] = requestWithSchema.mock.calls[0];
    expect(req).toEqual({ method: "tools/call", params: { name: "t" } });
    // withInputRequired() returns a Standard Schema.
    expect(schema).toHaveProperty("~standard");
    expect(options).toMatchObject({ allowInputRequired: true, signal });
  });
});
