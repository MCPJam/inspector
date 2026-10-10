import { describe, expect, it } from "vitest";
import {
  describeOrgKeysRefusal,
  notAnalyzedLine,
  isOrgKeysRefusalCode,
  isRetryableOrgKeysRefusal,
  notAnalyzedReason,
  orgKeysRefusalCodeFromError,
  orgKeysRefusalCodeOf,
  ORG_KEYS_REFUSAL_CODES,
} from "../org-keys-refusal";

describe("org-keys refusal helpers", () => {
  it("recognizes the policy codes plus credential_missing", () => {
    expect(ORG_KEYS_REFUSAL_CODES).toEqual([
      "org_keys_required",
      "org_model_unconfigured",
      "org_runtime_unsupported",
      "ai_scope_unresolved",
      "ai_policy_unavailable",
      "provider_auth_failed",
      "provider_unavailable",
      "credential_missing",
    ]);
    expect(isOrgKeysRefusalCode(" ORG_KEYS_REQUIRED ")).toBe(true);
    expect(isOrgKeysRefusalCode("credential_missing")).toBe(true);
    expect(isOrgKeysRefusalCode("mcpjam_rate_limit")).toBe(false);
    expect(isOrgKeysRefusalCode(undefined)).toBe(false);
    expect(orgKeysRefusalCodeOf("Provider_Auth_Failed")).toBe(
      "provider_auth_failed",
    );
  });

  it("marks only the two transient refusals retryable", () => {
    expect(isRetryableOrgKeysRefusal("provider_unavailable")).toBe(true);
    expect(isRetryableOrgKeysRefusal("ai_policy_unavailable")).toBe(true);
    expect(isRetryableOrgKeysRefusal("org_keys_required")).toBe(false);
  });

  it("finds the code in error objects, Convex data, JSON and prefixed messages", () => {
    expect(orgKeysRefusalCodeFromError({ code: "org_keys_required" })).toBe(
      "org_keys_required",
    );
    expect(
      orgKeysRefusalCodeFromError(
        Object.assign(new Error("refused"), {
          data: { code: "org_model_unconfigured" },
        }),
      ),
    ).toBe("org_model_unconfigured");
    expect(
      orgKeysRefusalCodeFromError(
        JSON.stringify({ ok: false, code: "credential_missing" }),
      ),
    ).toBe("credential_missing");
    expect(
      orgKeysRefusalCodeFromError(new Error("provider_auth_failed: 401")),
    ).toBe("provider_auth_failed");
    expect(orgKeysRefusalCodeFromError(new Error("Something else"))).toBe(
      undefined,
    );
  });

  it("describes by audience, with no admin detail for visitors", () => {
    expect(
      describeOrgKeysRefusal("provider_auth_failed", "admin").body,
    ).toMatch(/AI providers/);
    expect(
      describeOrgKeysRefusal("provider_auth_failed", "member").body,
    ).toMatch(/organization admin/);
    expect(describeOrgKeysRefusal("provider_auth_failed", "visitor").body).toBe(
      "This organization's analysis is unavailable.",
    );
  });

  it("words a skipped analysis as Not analyzed", () => {
    expect(notAnalyzedReason("org_model_unavailable")).toBe(
      "Not analyzed: this organization requires its own provider keys and has no model configured for analysis.",
    );
    expect(notAnalyzedReason("org_keys_required")).toMatch(/^Not analyzed: /);
    expect(notAnalyzedReason("something_new")).toMatch(/^Not analyzed: /);
  });
});

describe("notAnalyzedLine", () => {
  it("is the colon form for refusals and the findings skip, else undefined", () => {
    expect(notAnalyzedLine("org_model_unavailable")).toBe(
      "Not analyzed: this organization requires its own provider keys and has no model configured for analysis.",
    );
    expect(notAnalyzedLine("credential_missing")).toMatch(/^Not analyzed: /);
    expect(notAnalyzedLine("auto_limit_reached")).toBeUndefined();
    expect(notAnalyzedLine(undefined)).toBeUndefined();
  });
});
