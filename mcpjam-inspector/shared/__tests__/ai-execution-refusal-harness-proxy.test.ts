import { describe, expect, it } from "vitest";
import {
  AI_CONFIGURATION_REFUSAL_CODES,
  AI_EXECUTION_REFUSAL_CODES,
  AI_RETRYABLE_REFUSAL_CODES,
  aiRefusalRemediation,
} from "../ai-execution-refusal";
import { describeAiRefusal } from "../ai-refusal-copy";
import { HARNESS_PROXY_REFUSAL_REASONS } from "../harness-proxy-refusal-reasons";

/**
 * Two refusal lists live side by side: the organization key policy's codes
 * (`ai-execution-refusal.ts`) and the harness model proxy's reasons
 * (`harness-proxy-refusal-reasons.json`). They stay separate files, but a
 * code that is in both must mean the same thing in both.
 */
describe("codes shared by the key policy and the harness model proxy", () => {
  const shared = AI_EXECUTION_REFUSAL_CODES.filter((code) =>
    Object.prototype.hasOwnProperty.call(HARNESS_PROXY_REFUSAL_REASONS, code),
  );

  it("are exactly the policy refusal and the policy read failure", () => {
    // A new shared code needs its own row in the checks below.
    expect([...shared].sort()).toEqual([
      "ai_key_policy_unavailable",
      "org_keys_required",
    ]);
  });

  it("org_keys_required is permanent on both lists", () => {
    expect(HARNESS_PROXY_REFUSAL_REASONS.org_keys_required.retry).toBe(false);
    expect(AI_CONFIGURATION_REFUSAL_CODES.has("org_keys_required")).toBe(true);
    expect(AI_RETRYABLE_REFUSAL_CODES.has("org_keys_required")).toBe(false);
    expect(aiRefusalRemediation("org_keys_required")).toBe("choose_org_model");
  });

  it("ai_key_policy_unavailable is temporary, and only the proxy never re-sends it", () => {
    // The general classification: the backend could not read the policy and
    // failed closed. That lifts on its own.
    expect(AI_RETRYABLE_REFUSAL_CODES.has("ai_key_policy_unavailable")).toBe(
      true,
    );
    expect(
      AI_CONFIGURATION_REFUSAL_CODES.has("ai_key_policy_unavailable"),
    ).toBe(false);
    expect(aiRefusalRemediation("ai_key_policy_unavailable")).toBe(
      "retry_later",
    );
    // The proxy's own reply: it never re-sends a call, so it tells the
    // coding agent not to either. This is the one sanctioned difference.
    expect(HARNESS_PROXY_REFUSAL_REASONS.ai_key_policy_unavailable.retry).toBe(
      false,
    );
  });

  it("each shared code has its own copy, for members and admins", () => {
    for (const code of shared) {
      for (const audience of ["admin", "member"] as const) {
        const copy = describeAiRefusal(code, audience);
        expect(copy.title, `${code} ${audience}`).not.toBe("AI unavailable");
        expect(copy.body, `${code} ${audience}`).not.toMatch(
          /This AI request was refused/,
        );
      }
    }
  });
});
