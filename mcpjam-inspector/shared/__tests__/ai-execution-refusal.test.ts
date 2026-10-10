import { describe, expect, it } from "vitest";
import {
  AI_CONFIGURATION_REFUSAL_CODES,
  AI_EXECUTION_REFUSAL_CODES,
  AI_RETRYABLE_REFUSAL_CODES,
  aiRefusalRemediation,
  describeAiRefusal,
  findOrgKeyPolicyRefusalCode,
  isAiConfigurationRefusalCode,
  isAiExecutionRefusalCode,
  isOrgKeyPolicyRefusalCode,
  isRecognizedAiRefusalCode,
} from "../ai-execution-refusal";

describe("AI_EXECUTION_REFUSAL_CODES", () => {
  it("is the closed set the backend mirrors, in its order", () => {
    expect([...AI_EXECUTION_REFUSAL_CODES]).toEqual([
      "org_keys_required",
      "org_model_unconfigured",
      "org_runtime_unsupported",
      "ai_scope_unresolved",
      "ai_policy_unavailable",
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
    expect([...AI_CONFIGURATION_REFUSAL_CODES].sort()).toEqual(
      [
        "org_keys_required",
        "org_model_unconfigured",
        "org_runtime_unsupported",
        "ai_scope_unresolved",
        "provider_auth_failed",
        "credential_missing",
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
    expect(isAiConfigurationRefusalCode("ai_policy_unavailable")).toBe(false);
    expect(isAiConfigurationRefusalCode("provider_unavailable")).toBe(false);
    expect(isAiConfigurationRefusalCode("Org_Keys_Required")).toBe(true);
    expect(isAiConfigurationRefusalCode("credential_missing")).toBe(true);
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
        'Backend stream error: 503 {"ok":false,"code":"ai_policy_unavailable"}',
      ),
    ).toBe("ai_policy_unavailable");
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
    expect(aiRefusalRemediation("ai_policy_unavailable")).toBe("retry_later");
    expect(aiRefusalRemediation("provider_auth_failed")).toBe(
      "fix_org_credentials",
    );
    expect(aiRefusalRemediation("provider_unavailable")).toBe("retry_later");
    expect(aiRefusalRemediation("credential_missing")).toBe("add_org_provider");
    expect(aiRefusalRemediation("something_else")).toBe("contact_support");
    expect(aiRefusalRemediation(undefined)).toBe("contact_support");
  });
});

describe("describeAiRefusal", () => {
  it("tells an admin where to fix it", () => {
    const copy = describeAiRefusal("org_model_unconfigured", "admin");
    expect(copy.remediation).toBe("configure_org_model_role");
    expect(copy.body).toMatch(/Organization → AI providers/);
    expect(copy.body).not.toMatch(/ask an organization admin/i);
  });

  it("sends a member to an admin", () => {
    const copy = describeAiRefusal("provider_auth_failed", "member");
    expect(copy.remediation).toBe("fix_org_credentials");
    expect(copy.body).toMatch(/ask an organization admin/i);
    expect(copy.body).not.toMatch(/Organization → AI providers/);
  });

  it("uses the product's hosted-refusal sentence", () => {
    expect(describeAiRefusal("org_keys_required", "admin").body).toContain(
      "Choose a model from an organization provider.",
    );
  });

  it("gives visitors one neutral sentence with no admin detail", () => {
    for (const code of [...AI_EXECUTION_REFUSAL_CODES, "credential_missing"]) {
      const copy = describeAiRefusal(code, "visitor");
      expect(copy.body).toBe("This organization's analysis is unavailable.");
      expect(copy.body).not.toMatch(/admin|provider|key/i);
      expect(copy.remediation).toBe(aiRefusalRemediation(code));
    }
  });

  it("has dedicated copy for every recognized code and a fallback otherwise", () => {
    for (const code of [
      ...AI_EXECUTION_REFUSAL_CODES,
      "credential_missing",
      "capability_missing",
      "capability_unknown",
      "invalid_model",
    ]) {
      expect(isRecognizedAiRefusalCode(code)).toBe(true);
      for (const audience of ["admin", "member"] as const) {
        const copy = describeAiRefusal(code, audience);
        expect(copy.title).not.toBe("AI unavailable");
        expect(copy.body.length).toBeGreaterThan(0);
        // Configuration errors never read as an indefinite wait.
        expect(copy.body).not.toMatch(/paused/i);
      }
    }
    const fallback = describeAiRefusal("not_a_code");
    expect(fallback.title).toBe("AI unavailable");
    expect(fallback.remediation).toBe("contact_support");
    expect(isRecognizedAiRefusalCode("not_a_code")).toBe(false);
  });

  it("defaults to the member audience", () => {
    expect(describeAiRefusal("credential_missing")).toEqual(
      describeAiRefusal("credential_missing", "member"),
    );
  });
});
