import { expect, it } from "vitest";
import { defaultFallbackForPurpose, validateModelSelection } from "@mcpjam/sdk/browser";
import { MCPJAM_AGENT_MODEL, MCPJAM_AGENT_MODEL_SELECTION } from "../mcpjam-agent-model.js";

it("the platform agent carries its actual hosted choice and chat fallback", () => {
  expect(validateModelSelection(MCPJAM_AGENT_MODEL_SELECTION).ok).toBe(true);
  expect(MCPJAM_AGENT_MODEL_SELECTION).toEqual({ source: "hosted", modelId: MCPJAM_AGENT_MODEL, fallback: defaultFallbackForPurpose("chat") });
});
