import { describe, expect, it } from "vitest";
import {
  connectionPolicyEligibility,
  normalizeOrgAiKeyPolicy,
  normalizePolicyEligibility,
  orgRequiresOwnKeys,
} from "../org-ai-key-policy";

/** A connection row as the backend sends it, with or without a verdict. */
type Row = {
  providerKey?: string;
  runtimeLocation?: "cloud" | "local";
  policyEligibility?: unknown;
};

describe("connectionPolicyEligibility", () => {
  describe("the backend sent a verdict", () => {
    const ineligible: Row = {
      providerKey: "openrouter",
      policyEligibility: {
        eligible: false,
        code: "org_keys_required",
        message: "Use a direct provider connection.",
      },
    };

    it("returns it as sent, with the policy on or off", () => {
      for (const requireOrgKeys of [true, false]) {
        expect(connectionPolicyEligibility(ineligible, requireOrgKeys)).toEqual(
          {
            eligible: false,
            code: "org_keys_required",
            message: "Use a direct provider connection.",
          },
        );
        expect(
          connectionPolicyEligibility(
            { policyEligibility: { eligible: true } },
            requireOrgKeys,
          ),
        ).toEqual({ eligible: true });
      }
    });

    it("keeps another code from the shared refusal list", () => {
      expect(
        connectionPolicyEligibility(
          {
            policyEligibility: { eligible: false, code: "credential_missing" },
          },
          true,
        ),
      ).toEqual({ eligible: false, code: "credential_missing" });
    });

    it("never turns a provider key or a runtime into a verdict of its own", () => {
      // The backend is the only judge: a row it calls eligible stays
      // eligible, whatever the Inspector might have guessed from its fields.
      const localCustom: Row = {
        providerKey: "custom:acme",
        runtimeLocation: "local",
        policyEligibility: { eligible: true },
      };
      expect(connectionPolicyEligibility(localCustom, true)).toEqual({
        eligible: true,
      });
    });
  });

  describe("the verdict is missing (an older backend)", () => {
    const anthropic: Row = { providerKey: "anthropic" };
    const openRouter: Row = { providerKey: "openrouter" };

    it("fails closed while the policy is on", () => {
      expect(connectionPolicyEligibility(anthropic, true)).toEqual({
        eligible: false,
        code: "org_keys_required",
      });
      expect(connectionPolicyEligibility(undefined, true)).toEqual({
        eligible: false,
        code: "org_keys_required",
      });
    });

    it("refuses nothing while the policy is off", () => {
      expect(connectionPolicyEligibility(openRouter, false)).toEqual({
        eligible: true,
      });
      expect(connectionPolicyEligibility(anthropic, false)).toEqual({
        eligible: true,
      });
      expect(connectionPolicyEligibility(null, false)).toEqual({
        eligible: true,
      });
    });

    it("treats a malformed verdict as missing", () => {
      for (const policyEligibility of [
        null,
        "eligible",
        [],
        {},
        { eligible: "true" },
      ]) {
        expect(
          connectionPolicyEligibility({ policyEligibility }, true),
        ).toEqual({ eligible: false, code: "org_keys_required" });
        expect(
          connectionPolicyEligibility({ policyEligibility }, false),
        ).toEqual({ eligible: true });
      }
    });
  });
});

describe("normalizePolicyEligibility", () => {
  it("gives a refusal without a known code org_keys_required", () => {
    expect(normalizePolicyEligibility({ eligible: false })).toEqual({
      eligible: false,
      code: "org_keys_required",
    });
    expect(
      normalizePolicyEligibility({ eligible: false, code: "something_new" }),
    ).toEqual({ eligible: false, code: "org_keys_required" });
    expect(
      normalizePolicyEligibility({
        eligible: false,
        code: " ORG_KEYS_REQUIRED ",
      }),
    ).toEqual({ eligible: false, code: "org_keys_required" });
  });

  it("drops the code and message of an eligible verdict", () => {
    expect(
      normalizePolicyEligibility({
        eligible: true,
        code: "org_keys_required",
        message: "ignored",
      }),
    ).toEqual({ eligible: true });
  });

  it("trims the message and drops a blank one", () => {
    expect(
      normalizePolicyEligibility({ eligible: false, message: "  Why.  " }),
    ).toEqual({ eligible: false, code: "org_keys_required", message: "Why." });
    expect(
      normalizePolicyEligibility({ eligible: false, message: "   " }),
    ).toEqual({ eligible: false, code: "org_keys_required" });
    expect(
      normalizePolicyEligibility({ eligible: false, message: "x".repeat(900) })
        ?.message,
    ).toHaveLength(500);
  });
});

describe("the organization's policy", () => {
  it("reads only requireOrgKeys: true as on", () => {
    expect(orgRequiresOwnKeys({ aiKeyPolicy: { requireOrgKeys: true } })).toBe(
      true,
    );
    for (const config of [
      undefined,
      null,
      {},
      { aiKeyPolicy: null },
      { aiKeyPolicy: { requireOrgKeys: false } },
      { aiKeyPolicy: { requireOrgKeys: "true" } },
    ]) {
      expect(orgRequiresOwnKeys(config)).toBe(false);
    }
  });

  it("normalizes the policy from untrusted JSON", () => {
    expect(normalizeOrgAiKeyPolicy(undefined)).toBeUndefined();
    expect(normalizeOrgAiKeyPolicy([])).toBeUndefined();
    expect(normalizeOrgAiKeyPolicy({ requireOrgKeys: 1, revision: 3 })).toEqual(
      { requireOrgKeys: false, revision: 3 },
    );
    expect(
      normalizeOrgAiKeyPolicy({ requireOrgKeys: true, revision: "3" }),
    ).toEqual({ requireOrgKeys: true });
  });
});
