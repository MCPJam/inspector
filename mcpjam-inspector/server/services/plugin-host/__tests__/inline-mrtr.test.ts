import { describe, expect, it, vi } from "vitest";
import { createInlineMrtrCollector } from "../inline-mrtr.js";
import { validateRoundResponses, type MrtrInputCollector } from "@mcpjam/sdk";

type Input = Parameters<MrtrInputCollector>[0];
const form = {
  method: "elicitation/create" as const,
  params: {
    mode: "form" as const,
    message: "Choose",
    requestedSchema: { type: "object" as const, properties: {} },
    _meta: {
      "openai/elicitation": {
        requestedSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
      },
    },
  },
};
const input = (inputRequests: Input["inputRequests"], signal?: AbortSignal) =>
  ({
    inputRequests,
    signal,
    state: {
      version: 1,
      opId: "op",
      round: 1,
      method: "tools/call",
      originalParams: {},
      requestState: "state",
      pendingInputRequests: inputRequests,
    },
  }) as Input;

describe("owned inline MRTR form collection", () => {
  it("preserves server-selected keys that also name Object properties", async () => {
    const requests = Object.fromEntries(
      ["__proto__", "constructor", "toString"].map((key) => [key, form]),
    );
    const state = input(requests);
    const answer = vi.fn().mockResolvedValue({ action: "accept", content: { count: 0 } });
    const responses = await createInlineMrtrCollector("server", answer)(state);
    for (const key of Object.keys(requests)) {
      expect(Object.hasOwn(responses, key)).toBe(true);
      expect(responses[key]).toEqual({ action: "accept", content: { count: 0 } });
    }
    expect(() => validateRoundResponses(state.state, responses)).not.toThrow();
    expect(answer).toHaveBeenCalledTimes(3);
  });

  it("uses extension schemas and preserves zero and terminal actions", async () => {
    const answer = vi
      .fn()
      .mockResolvedValueOnce({ action: "accept", content: { count: 0 } })
      .mockResolvedValueOnce({ action: "decline" });
    const collect = createInlineMrtrCollector("server", answer);
    await expect(collect(input({ a: form, b: form }))).resolves.toEqual({
      a: { action: "accept", content: { count: 0 } },
      b: { action: "decline" },
    });
    expect(answer).toHaveBeenCalledWith({
      params: expect.objectContaining({
        requestedSchema: form.params._meta["openai/elicitation"].requestedSchema,
      }),
    });
  });
  it("refuses a mixed unsupported round before showing any form", async () => {
    const answer = vi.fn();
    const collect = createInlineMrtrCollector("server", answer);
    await expect(
      collect(
        input({
          a: form,
          b: {
            method: "elicitation/create",
            params: {
              mode: "url",
              message: "Open",
              url: "https://example.test",
            },
          },
        }),
      ),
    ).rejects.toThrow();
    expect(answer).not.toHaveBeenCalled();
  });
  it("refuses a missing extension schema before showing any form", async () => {
    const answer = vi.fn();
    const collect = createInlineMrtrCollector("server", answer);
    await expect(
      collect(input({ a: { ...form, params: { ...form.params, _meta: { "openai/elicitation": {} } } } })),
    ).rejects.toThrow();
    expect(answer).not.toHaveBeenCalled();
  });
  it("does not deliver an answer after the original operation is aborted", async () => {
    const controller = new AbortController();
    const answer = vi.fn(async () => {
      controller.abort();
      return { action: "accept", content: { count: 0 } };
    });
    const collect = createInlineMrtrCollector("server", answer);
    await expect(
      collect(input({ a: form }, controller.signal)),
    ).rejects.toThrow();
  });
});
