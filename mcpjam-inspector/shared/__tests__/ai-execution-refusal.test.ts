import { describe, expect, it } from "vitest";
import {
  AI_CONFIGURATION_REFUSAL_CODES,
  AI_EXECUTION_REFUSAL_CODES,
  AI_RETRYABLE_REFUSAL_CODES,
  aiRefusalRemediation,
  aiRefusalRemediationFor,
  findOrgKeyPolicyRefusalCode,
  isAiConfigurationRefusalCode,
  isAiExecutionRefusalCode,
  isOrgKeyPolicyRefusalCode,
} from "../ai-execution-refusal";

describe("AI_EXECUTION_REFUSAL_CODES", () => {
  it("is the closed set the backend mirrors, in its order", () => {
    expect([...AI_EXECUTION_REFUSAL_CODES]).toEqual([
      "org_keys_required",
      "org_model_unconfigured",
      "org_runtime_unsupported",
      "ai_scope_unresolved",
      "ai_key_policy_unavailable",
      "provider_auth_failed",
      "provider_unavailable",
    ]);
  });

  it("splits into configuration refusals and retryable ones", () => {
    for (const code of AI_EXECUTION_REFUSAL_CODES) {
      // Every policy code is exactly one of the two.
      expect(
        AI_CONFIGURATION_REFUSAL_CODES.has(code) !==
          AI_RETRYABLE_REFUSAL_CODES.has(code),
      ).toBe(true);
    }
    // The backend's permanent-until-configuration-change set: the policy
    // codes that don't lift on their own, plus the reused resolver codes.
    expect([...AI_CONFIGURATION_REFUSAL_CODES].sort()).toEqual(
      [
        "org_keys_required",
        "org_model_unconfigured",
        "org_runtime_unsupported",
        "ai_scope_unresolved",
        "provider_auth_failed",
        "credential_missing",
        "capability_missing",
        "capability_unknown",
        "invalid_model",
      ].sort(),
    );
  });
});

describe("isAiExecutionRefusalCode", () => {
  it("accepts the exact wire spelling only", () => {
    expect(isAiExecutionRefusalCode("org_keys_required")).toBe(true);
    expect(isAiExecutionRefusalCode("ORG_KEYS_REQUIRED")).toBe(false);
    expect(isAiExecutionRefusalCode("credential_missing")).toBe(false);
    expect(isAiExecutionRefusalCode(undefined)).toBe(false);
    expect(isAiExecutionRefusalCode(403)).toBe(false);
  });
});

describe("isOrgKeyPolicyRefusalCode", () => {
  it("is true for the seven policy codes in any case", () => {
    for (const code of AI_EXECUTION_REFUSAL_CODES) {
      expect(isOrgKeyPolicyRefusalCode(code)).toBe(true);
      expect(isOrgKeyPolicyRefusalCode(` ${code.toUpperCase()} `)).toBe(true);
    }
  });

  it("is false for reused and unrelated codes", () => {
    for (const code of [
      "credential_missing",
      "invalid_model",
      "user_rate_limit",
      "",
      null,
      undefined,
    ]) {
      expect(isOrgKeyPolicyRefusalCode(code)).toBe(false);
    }
  });
});

describe("isAiConfigurationRefusalCode", () => {
  it("never calls a retryable refusal a configuration one", () => {
    expect(isAiConfigurationRefusalCode("ai_key_policy_unavailable")).toBe(
      false,
    );
    expect(isAiConfigurationRefusalCode("provider_unavailable")).toBe(false);
    expect(isAiConfigurationRefusalCode("Org_Keys_Required")).toBe(true);
    expect(isAiConfigurationRefusalCode("credential_missing")).toBe(true);
    expect(isAiConfigurationRefusalCode("invalid_model")).toBe(true);
    expect(isAiConfigurationRefusalCode(undefined)).toBe(false);
  });
});

describe("findOrgKeyPolicyRefusalCode", () => {
  it("reads the code out of a stored refusal sentence", () => {
    expect(
      findOrgKeyPolicyRefusalCode(
        "Model selection refused — org_keys_required: This organization requires its own provider keys.",
      ),
    ).toBe("org_keys_required");
  });

  it("reads the code out of a JSON envelope", () => {
    expect(
      findOrgKeyPolicyRefusalCode(
        'Backend stream error: 503 {"ok":false,"code":"ai_key_policy_unavailable"}',
      ),
    ).toBe("ai_key_policy_unavailable");
  });

  it("does not match a code embedded in a longer identifier", () => {
    expect(findOrgKeyPolicyRefusalCode("xorg_keys_required")).toBeUndefined();
    expect(findOrgKeyPolicyRefusalCode("credential_missing")).toBeUndefined();
    expect(findOrgKeyPolicyRefusalCode("")).toBeUndefined();
    expect(findOrgKeyPolicyRefusalCode(null)).toBeUndefined();
  });
});

describe("aiRefusalRemediation", () => {
  it("pairs each code with the backend's remediation", () => {
    expect(aiRefusalRemediation("org_keys_required")).toBe("choose_org_model");
    expect(aiRefusalRemediation("org_model_unconfigured")).toBe(
      "configure_org_model_role",
    );
    expect(aiRefusalRemediation("org_runtime_unsupported")).toBe("unsupported");
    expect(aiRefusalRemediation("ai_scope_unresolved")).toBe("contact_support");
    expect(aiRefusalRemediation("ai_key_policy_unavailable")).toBe(
      "retry_later",
    );
    expect(aiRefusalRemediation("provider_auth_failed")).toBe(
      "fix_org_credentials",
    );
    expect(aiRefusalRemediation("provider_unavailable")).toBe("retry_later");
    expect(aiRefusalRemediation("credential_missing")).toBe("add_org_provider");
    for (const code of [
      "capability_missing",
      "capability_unknown",
      "invalid_model",
    ]) {
      expect(aiRefusalRemediation(code)).toBe("configure_org_model_role");
    }
    expect(aiRefusalRemediation("something_else")).toBe("contact_support");
    expect(aiRefusalRemediation(undefined)).toBe("contact_support");
  });
});

describe("aiRefusalRemediationFor", () => {
  const modelCodes = ["capability_missing", "capability_unknown", "invalid_model"];

  it("sends a person who picked the model to choose another one", () => {
    for (const code of modelCodes) {
      expect(aiRefusalRemediationFor(code)).toBe("choose_org_model");
      expect(aiRefusalRemediationFor(code, "picked")).toBe("choose_org_model");
    }
  });

  it("keeps the backend's role fix for role-backed work", () => {
    for (const code of modelCodes) {
      expect(aiRefusalRemediationFor(code, "role")).toBe(
        "configure_org_model_role",
      );
    }
  });

  it("matches the backend for every other code on both surfaces", () => {
    for (const code of [...AI_EXECUTION_REFUSAL_CODES, "credential_missing"]) {
      expect(aiRefusalRemediationFor(code, "picked")).toBe(
        aiRefusalRemediation(code),
      );
      expect(aiRefusalRemediationFor(code, "role")).toBe(
        aiRefusalRemediation(code),
      );
    }
  });
});
