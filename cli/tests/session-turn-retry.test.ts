import assert from "node:assert/strict";
import test from "node:test";
import { PlatformApiError } from "@mcpjam/sdk/platform";
import { waitForSessionTurn } from "../src/lib/session-turn-retry.js";
test("waits the server delay and reuses the same operation for an active turn", async () => {
  let calls = 0;
  const waited: number[] = [];
  const result = await waitForSessionTurn(
    async () => {
      if (++calls === 1)
        throw new PlatformApiError("busy", "CONFLICT", {
          status: 409,
          details: { reason: "TURN_IN_PROGRESS", retryAfterMs: 2000 },
        });
      return { replay: true };
    },
    undefined,
    async (ms) => {
      waited.push(ms);
    }
  );
  assert.deepEqual(result, { replay: true });
  assert.deepEqual(waited, [2000]);
  assert.equal(calls, 2);
});
test("never retries an unknown outcome", async () => {
  const error = new PlatformApiError("unknown", "CONFLICT", {
    status: 409,
    details: { reason: "TURN_OUTCOME_UNKNOWN" },
  });
  await assert.rejects(
    waitForSessionTurn(async () => {
      throw error;
    }),
    (e) => e === error
  );
});
