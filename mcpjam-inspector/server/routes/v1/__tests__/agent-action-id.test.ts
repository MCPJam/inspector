import { describe, expect, it } from "vitest";
import {
  AGENT_API_GATED_OPERATIONS,
  MAX_AGENT_ACTION_ID_LENGTH,
  isValidAgentActionId,
} from "../agent.js";

describe("surface action id contract", () => {
  it("keeps every registered gated operation within the opaque id budget", () => {
    for (const operation of AGENT_API_GATED_OPERATIONS) {
      expect(`proposal:${operation.name}`.length).toBeLessThanOrEqual(
        MAX_AGENT_ACTION_ID_LENGTH,
      );
    }
  });

  it("rejects ids that Discord cannot carry", () => {
    expect(isValidAgentActionId("a".repeat(MAX_AGENT_ACTION_ID_LENGTH))).toBe(
      true,
    );
    expect(
      isValidAgentActionId("a".repeat(MAX_AGENT_ACTION_ID_LENGTH + 1)),
    ).toBe(false);
  });
});
