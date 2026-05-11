import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("@/lib/billing-entitlements", () => ({
  getBillingErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

import { showByokErrorToast } from "../byok-toast";

beforeEach(() => {
  toastErrorMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const buildByokError = (
  code: string,
  providerKey = "openai",
  message = "Provider not configured for this organization.",
) => new Error(JSON.stringify({ code, providerKey, message }));

describe("showByokErrorToast", () => {
  it("renders a persistent toast with action when given a BYOK error and openOrgModels", () => {
    const openOrgModels = vi.fn();
    showByokErrorToast(
      buildByokError("byok_provider_missing"),
      "Failed to start evals",
      openOrgModels,
    );

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    const [message, options] = toastErrorMock.mock.calls[0]!;
    expect(message).toBe("Provider not configured for this organization.");
    expect(options).toMatchObject({
      duration: Number.POSITIVE_INFINITY,
      action: { label: "Open Organization Models" },
    });
    expect(typeof options.action.onClick).toBe("function");

    options.action.onClick();
    expect(openOrgModels).toHaveBeenCalledTimes(1);
  });

  it("omits the action button when openOrgModels is undefined", () => {
    showByokErrorToast(
      buildByokError("byok_invalid_key"),
      "Failed to start evals",
      undefined,
    );

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    const [, options] = toastErrorMock.mock.calls[0]!;
    expect(options).toMatchObject({ duration: Number.POSITIVE_INFINITY });
    expect(options.action).toBeUndefined();
  });

  it("recognizes every BYOK code (including the codes the inspector currently emits)", () => {
    const codes = [
      "byok_provider_missing",
      "byok_provider_disabled",
      "byok_invalid_key",
      "byok_provider_misconfigured",
      "provider_not_configured",
      "provider_auth_error",
      "model_not_allowed",
      "local_runtime_required",
      "local_runtime_not_allowed",
    ];
    const openOrgModels = vi.fn();

    for (const code of codes) {
      toastErrorMock.mockReset();
      showByokErrorToast(buildByokError(code), "fallback", openOrgModels);
      const [, options] = toastErrorMock.mock.calls[0]!;
      expect(options).toMatchObject({
        duration: Number.POSITIVE_INFINITY,
        action: { label: "Open Organization Models" },
      });
    }
  });

  it("forwards a sonner id when extras.id is provided (replaces in-flight toast)", () => {
    const openOrgModels = vi.fn();
    showByokErrorToast(
      buildByokError("byok_provider_missing"),
      "fallback",
      openOrgModels,
      { id: "replay-toast-123" },
    );

    const [, options] = toastErrorMock.mock.calls[0]!;
    expect(options).toMatchObject({ id: "replay-toast-123" });
  });

  it("falls back to billing message for non-BYOK errors", () => {
    const openOrgModels = vi.fn();
    showByokErrorToast(
      new Error("Something else went wrong"),
      "Failed to start evals",
      openOrgModels,
    );

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    const [message, options] = toastErrorMock.mock.calls[0]!;
    expect(message).toBe("Something else went wrong");
    // No persistent duration, no action — plain toast.
    expect(options).toBeUndefined();
  });

  it("forwards id even on the non-BYOK fallback path", () => {
    showByokErrorToast(
      new Error("Server failed"),
      "fallback",
      undefined,
      { id: "replay-toast-456" },
    );

    const [, options] = toastErrorMock.mock.calls[0]!;
    expect(options).toMatchObject({ id: "replay-toast-456" });
  });

  it("treats org-scoped auth_error as BYOK and surfaces the CTA", () => {
    const openOrgModels = vi.fn();
    const error = new Error(
      JSON.stringify({
        code: "auth_error",
        message:
          "Invalid API key for the org provider. Please check your organization's LLM provider settings.",
      }),
    );
    showByokErrorToast(error, "fallback", openOrgModels);

    const [, options] = toastErrorMock.mock.calls[0]!;
    expect(options).toMatchObject({
      duration: Number.POSITIVE_INFINITY,
      action: { label: "Open Organization Models" },
    });
  });

  it("does NOT treat plain auth_error (local Ollama) as BYOK", () => {
    const openOrgModels = vi.fn();
    const error = new Error(
      JSON.stringify({
        code: "auth_error",
        message:
          "Invalid API key for ollama. Please check your key under LLM Providers in Settings.",
      }),
    );
    showByokErrorToast(error, "fallback", openOrgModels);

    const [, options] = toastErrorMock.mock.calls[0]!;
    // Plain toast — no infinite duration, no action.
    expect(options).toBeUndefined();
  });

  it("ignores BYOK-shaped JSON when the code is unknown", () => {
    showByokErrorToast(
      new Error(
        JSON.stringify({
          code: "some_other_error",
          message: "Different code path",
        }),
      ),
      "fallback",
      vi.fn(),
    );

    const [message, options] = toastErrorMock.mock.calls[0]!;
    // Falls through: getBillingErrorMessage gets the raw Error, returns message.
    expect(typeof message).toBe("string");
    expect(options).toBeUndefined();
  });
});
