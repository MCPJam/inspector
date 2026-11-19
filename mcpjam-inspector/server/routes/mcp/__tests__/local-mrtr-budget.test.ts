import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MCPClientManager,
  type InputRequests,
  type MrtrInputCollector,
} from "@mcpjam/sdk";
import { LOCAL_MRTR_MAX_FRAME_BYTES } from "@/shared/local-mrtr-wire";
import type { MrtrRoundEvent } from "@/shared/local-mrtr";
import {
  pendingMrtrRoundCount,
  projectInputRequests,
  registerLocalMrtrCollector,
  submitMrtrResponses,
  subscribeLocalMrtrEvents,
} from "../mrtr";

function request(message: string): InputRequests {
  return {
    q: {
      method: "elicitation/create",
      params: { message, requestedSchema: { type: "object", properties: {} } },
    },
  };
}

const controllers: AbortController[] = [];
const outcomes: Promise<unknown>[] = [];

function fixture(opId: string) {
  const manager = new MCPClientManager({});
  let collect: MrtrInputCollector = async () => {
    throw new Error("Collector not installed");
  };
  vi.spyOn(manager, "setMrtrInputCollector").mockImplementation(
    (_id, collector) => {
      collect = collector;
    },
  );
  registerLocalMrtrCollector(manager, "budget");
  const controller = new AbortController();
  controllers.push(controller);
  const signal = controller.signal;
  const listener = vi.spyOn(signal, "addEventListener");
  const events: unknown[] = [];
  const release = subscribeLocalMrtrEvents(
    { send: (event) => events.push(event), close() {} },
    () => {},
  );
  const run = (inputRequests: InputRequests) => {
    const result = collect({
      state: {
        opId,
        method: "tools/call",
        originalParams: { name: "fixture" },
        round: 1,
        maxRounds: 10,
        pendingInputRequests: {},
      },
      inputRequests,
      signal,
    });
    outcomes.push(
      result.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
    );
    return result;
  };
  return { run, events, listener, release };
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(outcomes.splice(0));
  vi.restoreAllMocks();
});

describe("local MRTR aggregate budget", () => {
  it("delivers an aggregate of individually valid schemas above the hydration limit", async () => {
    const f = fixture("aggregate");
    const schema = {
      type: "object" as const,
      properties: {
        value: { type: "string" as const, description: "x".repeat(200 * 1024) },
      },
    };
    const input: InputRequests = {};
    for (let index = 0; index < 6; index++)
      input[`q${index}`] = {
        method: "elicitation/create",
        params: { message: "Large schema", requestedSchema: schema },
      };
    const result = f.run(input);
    try {
      expect(Buffer.byteLength(JSON.stringify(f.events[0]))).toBeGreaterThan(
        1024 * 1024,
      );
      expect(pendingMrtrRoundCount()).toBe(1);
      expect(
        submitMrtrResponses(
          "aggregate",
          Object.fromEntries(
            Object.keys(input).map((key) => [
              key,
              { action: "cancel" as const },
            ]),
          ),
          "aggregate:1",
        ).ok,
      ).toBe(true);
      await result;
    } finally {
      f.release();
    }
  });

  it.each([0, 1])(
    "enforces the serialized full-round boundary plus %i byte",
    async (extra) => {
      const opId = `boundary-${extra}`;
      const f = fixture(opId);
      const base: MrtrRoundEvent = {
        type: "mrtr_input_request",
        opId,
        roundKey: `${opId}:1`,
        round: 1,
        serverId: "budget",
        requests: projectInputRequests(request("")),
        timestamp: "2000-01-01T00:00:00.000Z",
      };
      const input = request(
        "x".repeat(
          LOCAL_MRTR_MAX_FRAME_BYTES -
            Buffer.byteLength(JSON.stringify(base)) +
            extra,
        ),
      );
      const result = f.run(input);
      try {
        if (extra) {
          await expect(result).rejects.toThrow(/30 MiB.*split/);
          expect(f.listener).not.toHaveBeenCalled();
          expect(f.events).toEqual([]);
          expect(pendingMrtrRoundCount()).toBe(0);
        } else {
          expect(Buffer.byteLength(JSON.stringify(f.events[0]))).toBe(
            LOCAL_MRTR_MAX_FRAME_BYTES,
          );
          expect(
            submitMrtrResponses(opId, { q: { action: "cancel" } }, `${opId}:1`)
              .ok,
          ).toBe(true);
          await result;
        }
      } finally {
        f.release();
      }
    },
  );
});
