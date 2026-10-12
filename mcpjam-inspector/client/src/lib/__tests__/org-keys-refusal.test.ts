import { describe, expect, it } from "vitest";
import {
  describeOrgKeysRefusal,
  isOrgKeysRefusalCode,
  isRetryableOrgKeysRefusal,
  notAnalyzedLine,
  notAnalyzedReason,
  orgKeysRefusalCodeFromError,
  orgKeysRefusalCodeOf,
  orgKeysRefusalSentence,
  ORG_KEYS_REFUSAL_CODES,
  VISITOR_ANALYSIS_UNAVAILABLE,
} from "../org-keys-refusal";

describe("org-keys refusal helpers", () => {
  it("recognizes the policy codes plus credential_missing", () => {
    expect(ORG_KEYS_REFUSAL_CODES).toEqual([
      "org_keys_required",
      "org_model_unconfigured",
      "org_runtime_unsupported",
      "ai_scope_unresolved",
      "ai_key_policy_unavailable",
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
    expect(isRetryableOrgKeysRefusal("ai_key_policy_unavailable")).toBe(true);
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

  it("reads the code an Error carries even when its message is generic", () => {
    expect(
      orgKeysRefusalCodeFromError(
        Object.assign(new Error("Request failed"), {
          code: "org_keys_required",
        }),
      ),
    ).toBe("org_keys_required");
    // An Error's unrelated code (a Node errno) is still not a refusal.
    expect(
      orgKeysRefusalCodeFromError(
        Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
      ),
    ).toBe(undefined);
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
      "Not analyzed because this organization requires its own provider keys and has no compatible default AI model. An organization admin needs to choose one in Organization → AI providers.",
    );
    expect(notAnalyzedReason("org_runtime_unsupported")).toBe(
      "Not analyzed. This feature can't run on the organization's providers yet, so it is unavailable while the organization requires its own keys.",
    );
    expect(notAnalyzedReason("org_keys_required")).toMatch(/^Not analyzed[. ]/);
    expect(notAnalyzedReason("something_new")).toMatch(/^Not analyzed[. ]/);
  });

  it("adds the next step for the reader, and none where there is nothing to do", () => {
    expect(notAnalyzedReason("org_keys_required", "admin")).toBe(
      "Not analyzed because this organization requires its own provider keys for AI features. Check its providers in Organization → AI providers.",
    );
    expect(notAnalyzedReason("org_keys_required")).toBe(
      "Not analyzed because this organization requires its own provider keys for AI features. Ask an organization admin to check its AI providers.",
    );
    expect(notAnalyzedReason("provider_auth_failed", "admin")).toBe(
      "Not analyzed. The organization's provider rejected its API key. Update the key in Organization → AI providers.",
    );
    expect(notAnalyzedReason("provider_auth_failed", "member")).toBe(
      "Not analyzed. The organization's provider rejected its API key. Ask an organization admin to update it.",
    );
    expect(notAnalyzedReason("credential_missing", "member")).toMatch(
      /Ask an organization admin to add one\.$/,
    );
    // Unsupported analysis never suggests a provider or model change can fix it.
    for (const code of ["org_runtime_unsupported"]) {
      for (const audience of ["admin", "member"] as const) {
        expect(notAnalyzedReason(code, audience)).not.toMatch(
          /Add |Ask an organization admin|Update /,
        );
      }
    }
    const unresolved = notAnalyzedReason("ai_scope_unresolved", "member");
    expect(unresolved).toMatch(/contact support/i);
    expect(unresolved).not.toMatch(
      /Add .*provider|Update .*key|Choose .*model/,
    );
  });

  it("gives a share-link visitor the shared visitor sentence", () => {
    expect(VISITOR_ANALYSIS_UNAVAILABLE).toBe(
      "This organization's analysis is unavailable.",
    );
  });
});

describe("orgKeysRefusalSentence", () => {
  it("reads the backend's reason out of a stream error envelope (Ask MCPJam)", () => {
    expect(
      orgKeysRefusalSentence(
        JSON.stringify({
          ok: false,
          code: "org_runtime_unsupported",
          error:
            "Ask MCPJam can't run on this organization's providers yet, so it is unavailable while the organization requires its own keys.",
          isRetryable: false,
          remediation: "unsupported",
        }),
      ),
    ).toBe(
      "Ask MCPJam can't run on this organization's providers yet, so it is unavailable while the organization requires its own keys.",
    );
  });

  it("falls back to the plain copy when the envelope only echoes the code", () => {
    expect(
      orgKeysRefusalSentence(
        '{"ok":false,"code":"org_keys_required","error":"org_keys_required"}',
      ),
    ).toMatch(/requires its own provider keys/);
    expect(orgKeysRefusalSentence("org_runtime_unsupported: nope")).toMatch(
      /can't run on the organization's providers yet/,
    );
  });

  it("leaves anything else to the caller", () => {
    expect(
      orgKeysRefusalSentence('{"code":"agent_turn_limit"}'),
    ).toBeUndefined();
    expect(orgKeysRefusalSentence("boom")).toBeUndefined();
    expect(orgKeysRefusalSentence(undefined)).toBeUndefined();
  });
});

describe("notAnalyzedLine", () => {
  it("is the colon form for refusals and the findings skip, else undefined", () => {
    expect(notAnalyzedLine("org_model_unavailable")).toBe(
      "Not analyzed because this organization requires its own provider keys and has no compatible default AI model. An organization admin needs to choose one in Organization → AI providers.",
    );
    expect(notAnalyzedLine("credential_missing")).toMatch(/^Not analyzed[. ]/);
    expect(notAnalyzedLine(" ORG_RUNTIME_UNSUPPORTED ")).toMatch(
      /can't run on the organization's providers yet/,
    );
    expect(notAnalyzedLine("auto_limit_reached")).toBeUndefined();
    expect(notAnalyzedLine("invalid_model")).toBeUndefined();
    expect(notAnalyzedLine(undefined)).toBeUndefined();
  });
});
