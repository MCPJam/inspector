import assert from "node:assert/strict";
import test from "node:test";
import { isUnactionableAiSdkWarning } from "../src/commands/test.js";

test("drops the AI SDK's unknown-model output-token notice", () => {
  // Fires on every MCPJam-rail run: the AI SDK's model table does not know
  // gateway-style ids, and nothing in `mcpjam test` can change that.
  assert.equal(
    isUnactionableAiSdkWarning({
      type: "other",
      message:
        'The model "anthropic/claude-haiku-4.5" is unknown. The max output tokens have been limited to 128000. Set maxOutputTokens explicitly to override this limit.',
    }),
    true
  );
});

test("drops the provider-adapter compatibility notice", () => {
  assert.equal(
    isUnactionableAiSdkWarning({
      type: "compatibility",
      feature: "specificationVersion",
    }),
    true
  );
});

test("keeps warnings about the user's own settings", () => {
  assert.equal(
    isUnactionableAiSdkWarning({
      type: "unsupported-setting",
      feature: "temperature",
      details: "temperature is not supported for reasoning models",
    }),
    false
  );
  assert.equal(
    isUnactionableAiSdkWarning({
      type: "other",
      message: "The model returned an unexpected finish reason.",
    }),
    false
  );
});
