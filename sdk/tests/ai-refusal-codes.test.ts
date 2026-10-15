import { describe, expect, it } from "vitest";
import {
  AI_CONFIGURATION_REFUSAL_CODES,
  AI_EXECUTION_REFUSAL_CODES,
  AI_REFUSAL_CODES,
  AI_RETRYABLE_REFUSAL_CODES,
  AI_REUSED_REFUSAL_CODES,
  aiRefusalClass,
  isAiExecutionRefusalCode,
  recognizedAiRefusalCode,
} from "../src/ai-refusal-codes.js";
import {
  describeError,
  orgPolicySlugForCode,
} from "../src/error-describer/index.js";

describe("AI refusal vocabulary", () => {
  it("lists the policy's own codes first, then the reused ones, once each", () => {
    expect([...AI_REFUSAL_CODES]).toEqual([
      ...AI_EXECUTION_REFUSAL_CODES,
      ...AI_REUSED_REFUSAL_CODES,
    ]);
    expect(new Set(AI_REFUSAL_CODES).size).toBe(AI_REFUSAL_CODES.length);
  });

  it("puts every code in exactly one class", () => {
    for (const code of AI_REFUSAL_CODES) {
      const temporary = aiRefusalClass(code) === "temporary";
      expect(AI_RETRYABLE_REFUSAL_CODES.has(code), code).toBe(temporary);
      expect(AI_CONFIGURATION_REFUSAL_CODES.has(code), code).toBe(!temporary);
    }
    expect(
      AI_RETRYABLE_REFUSAL_CODES.size + AI_CONFIGURATION_REFUSAL_CODES.size
    ).toBe(AI_REFUSAL_CODES.length);
    // Only the policy read failing and the org's provider failing lift on
    // their own.
    expect([...AI_RETRYABLE_REFUSAL_CODES].sort()).toEqual([
      "ai_key_policy_unavailable",
      "provider_unavailable",
    ]);
  });

  it("recognizes a code in any case or spacing, and nothing else", () => {
    expect(recognizedAiRefusalCode(" ORG_KEYS_REQUIRED ")).toBe(
      "org_keys_required"
    );
    expect(recognizedAiRefusalCode("Invalid_Model")).toBe("invalid_model");
    expect(recognizedAiRefusalCode("user_rate_limit")).toBeUndefined();
    expect(recognizedAiRefusalCode(null)).toBeUndefined();
    expect(isAiExecutionRefusalCode("org_keys_required")).toBe(true);
    expect(isAiExecutionRefusalCode("ORG_KEYS_REQUIRED")).toBe(false);
    expect(isAiExecutionRefusalCode("credential_missing")).toBe(false);
  });
});

describe("tables derived from the vocabulary", () => {
  it("gives every policy code, and only those, its own catalog slug", () => {
    const slugs = AI_EXECUTION_REFUSAL_CODES.map((code) =>
      orgPolicySlugForCode(code)
    );
    for (const slug of slugs) expect(slug).toMatch(/^org\//);
    expect(new Set(slugs).size).toBe(AI_EXECUTION_REFUSAL_CODES.length);
    for (const code of AI_REUSED_REFUSAL_CODES) {
      expect(orgPolicySlugForCode(code), code).toBeUndefined();
    }
  });

  it("reads every policy code out of the engine's error text", () => {
    for (const code of AI_EXECUTION_REFUSAL_CODES) {
      const result = describeError(
        new Error(`The model did not run. (${code}, HTTP 403)`)
      );
      expect(result.slug, code).toBe(orgPolicySlugForCode(code));
      expect(result.rawCode, code).toBe(code);
    }
  });
});
