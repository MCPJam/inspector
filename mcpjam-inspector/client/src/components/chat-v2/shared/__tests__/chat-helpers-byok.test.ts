import { describe, expect, it } from "vitest";
import {
  BYOK_ERROR_CODES,
  BYOK_INVALID_KEY_CODE,
  BYOK_PROVIDER_DISABLED_CODE,
  BYOK_PROVIDER_MISCONFIGURED_CODE,
  BYOK_PROVIDER_MISSING_CODE,
  MODEL_NOT_ALLOWED_CODE,
  LOCAL_RUNTIME_NOT_ALLOWED_CODE,
  LOCAL_RUNTIME_REQUIRED_CODE,
  PROVIDER_AUTH_ERROR_CODE,
  PROVIDER_NOT_CONFIGURED_CODE,
  formatErrorMessage,
  isByokErrorCode,
  isOrgScopedAuthError,
} from "../chat-helpers";

describe("BYOK error code helpers", () => {
  it("exports the BYOK codes in BYOK_ERROR_CODES (forward-looking + currently emitted)", () => {
    expect(BYOK_ERROR_CODES.has(BYOK_PROVIDER_MISSING_CODE)).toBe(true);
    expect(BYOK_ERROR_CODES.has(BYOK_PROVIDER_DISABLED_CODE)).toBe(true);
    expect(BYOK_ERROR_CODES.has(BYOK_INVALID_KEY_CODE)).toBe(true);
    expect(BYOK_ERROR_CODES.has(BYOK_PROVIDER_MISCONFIGURED_CODE)).toBe(true);
    // Codes the inspector currently emits via OrgProviderConfigError /
    // formatLocalStreamError.
    expect(BYOK_ERROR_CODES.has(PROVIDER_NOT_CONFIGURED_CODE)).toBe(true);
    expect(BYOK_ERROR_CODES.has(PROVIDER_AUTH_ERROR_CODE)).toBe(true);
    expect(BYOK_ERROR_CODES.has(MODEL_NOT_ALLOWED_CODE)).toBe(true);
    expect(BYOK_ERROR_CODES.has(LOCAL_RUNTIME_REQUIRED_CODE)).toBe(true);
    expect(BYOK_ERROR_CODES.has(LOCAL_RUNTIME_NOT_ALLOWED_CODE)).toBe(true);
    expect(BYOK_ERROR_CODES.size).toBe(9);
  });

  it("isByokErrorCode returns true for BYOK codes and false for others", () => {
    expect(isByokErrorCode(BYOK_PROVIDER_MISSING_CODE)).toBe(true);
    expect(isByokErrorCode(PROVIDER_NOT_CONFIGURED_CODE)).toBe(true);
    expect(isByokErrorCode(PROVIDER_AUTH_ERROR_CODE)).toBe(true);
    expect(isByokErrorCode(MODEL_NOT_ALLOWED_CODE)).toBe(true);
    expect(isByokErrorCode("user_rate_limit")).toBe(false);
    expect(isByokErrorCode("auth_error")).toBe(false);
    expect(isByokErrorCode(undefined)).toBe(false);
    expect(isByokErrorCode(null)).toBe(false);
  });
});

describe("isOrgScopedAuthError", () => {
  it("matches the org-aware auth_error message", () => {
    expect(
      isOrgScopedAuthError(
        "auth_error",
        "Invalid API key for the org provider. Please check your organization's LLM provider settings.",
      ),
    ).toBe(true);
  });

  it("rejects plain auth_error (local Ollama path)", () => {
    expect(
      isOrgScopedAuthError(
        "auth_error",
        "Invalid API key for ollama. Please check your key under LLM Providers in Settings.",
      ),
    ).toBe(false);
  });

  it("rejects non-auth codes", () => {
    expect(isOrgScopedAuthError("provider_not_configured", "anything")).toBe(
      false,
    );
    expect(isOrgScopedAuthError(undefined, "anything")).toBe(false);
  });

  it("rejects auth_error without a string message", () => {
    expect(isOrgScopedAuthError("auth_error", undefined)).toBe(false);
    expect(isOrgScopedAuthError("auth_error", null)).toBe(false);
    expect(isOrgScopedAuthError("auth_error", 42)).toBe(false);
  });
});

describe("formatErrorMessage providerKey passthrough", () => {
  it("extracts providerKey from a BYOK error payload", () => {
    const payload = JSON.stringify({
      code: "byok_provider_missing",
      providerKey: "openai",
      message: "OpenAI is not configured for this organization.",
    });
    const result = formatErrorMessage(payload);

    expect(result).toMatchObject({
      code: "byok_provider_missing",
      providerKey: "openai",
      message: "OpenAI is not configured for this organization.",
    });
  });

  it("omits providerKey when the field is missing", () => {
    const payload = JSON.stringify({
      code: "byok_invalid_key",
      message: "Bad key",
    });
    const result = formatErrorMessage(payload);

    expect(result?.code).toBe("byok_invalid_key");
    expect(result).not.toHaveProperty("providerKey");
  });

  it("omits providerKey when the field is an empty string", () => {
    const payload = JSON.stringify({
      code: "byok_invalid_key",
      providerKey: "",
      message: "Bad key",
    });
    const result = formatErrorMessage(payload);

    expect(result).not.toHaveProperty("providerKey");
  });

  it("ignores non-string providerKey values", () => {
    const payload = JSON.stringify({
      code: "byok_invalid_key",
      providerKey: 42,
      message: "Bad key",
    });
    const result = formatErrorMessage(payload);

    expect(result).not.toHaveProperty("providerKey");
  });
});
