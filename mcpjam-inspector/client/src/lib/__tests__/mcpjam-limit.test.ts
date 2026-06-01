import { beforeEach, describe, expect, it } from "vitest";
import {
  isMCPJamModelLimitError,
  notifyMCPJamLimitError,
  notifyMCPJamLimitErrorFromResponse,
} from "../mcpjam-limit";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

beforeEach(() => {
  useMCPJamLimitDialogStore.setState({
    authStatus: "loading",
    hasPendingLimit: false,
    isOpen: false,
    intent: null,
    organizationId: null,
    pendingInput: null,
  });
});

describe("isMCPJamModelLimitError", () => {
  it("detects the canonical rate-limit code", () => {
    expect(isMCPJamModelLimitError({ code: "mcpjam_rate_limit" })).toBe(true);
  });

  it("detects the signed-in user_rate_limit code", () => {
    expect(isMCPJamModelLimitError({ code: "user_rate_limit" })).toBe(true);
  });

  it("does not match concurrency-throttled user_rate_limit", () => {
    expect(
      isMCPJamModelLimitError({
        code: "user_rate_limit",
        limitKind: "concurrency",
      }),
    ).toBe(false);
  });

  it("matches user_rate_limit when limitKind is total", () => {
    expect(
      isMCPJamModelLimitError({
        code: "user_rate_limit",
        limitKind: "total",
      }),
    ).toBe(true);
  });

  it("detects rate-limit codes inside structured details", () => {
    expect(
      isMCPJamModelLimitError({
        message: "Backend stream error: 429",
        details: JSON.stringify({
          code: "mcpjam_rate_limit",
          error: "Daily usage limit reached.",
        }),
      }),
    ).toBe(true);
  });

  it("detects rate-limit codes inside prefixed backend strings", () => {
    expect(
      isMCPJamModelLimitError({
        message:
          'Backend stream error: 429 {"code":"mcpjam_rate_limit","error":"Daily usage limit reached."}',
      }),
    ).toBe(true);
  });

  it("detects signed-in usage limits inside prefixed backend strings", () => {
    expect(
      isMCPJamModelLimitError({
        message:
          'Backend stream error: 429 {"code":"user_rate_limit","error":"Daily credit limit reached.","limitKind":"total"}',
      }),
    ).toBe(true);
  });

  it("does not match streamed concurrency throttles inside prefixed backend strings", () => {
    expect(
      isMCPJamModelLimitError({
        message:
          'Backend stream error: 429 {"code":"user_rate_limit","error":"Another credit-funded chat is finishing.","limitKind":"concurrency"}',
      }),
    ).toBe(false);
  });

  it("detects model-limit text inside structured details", () => {
    expect(
      isMCPJamModelLimitError({
        message: "Backend stream error: 429",
        details: {
          error:
            "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
        },
      }),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(
      isMCPJamModelLimitError({
        message: "Provider unavailable",
        details: JSON.stringify({ code: "provider_error" }),
      }),
    ).toBe(false);
  });

  it("opens immediately when a guest gets a fresh limit error", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "guest",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    expect(notifyMCPJamLimitError({ code: "mcpjam_rate_limit" })).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().intent).toBe("guest");
  });

  it("opens with topup intent for signed-in user_rate_limit hits", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    expect(notifyMCPJamLimitError({ code: "user_rate_limit" })).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().intent).toBe("topup");
  });

  it("opens with topup intent for wrapped signed-in usage limit hits", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    expect(
      notifyMCPJamLimitError({
        message:
          'Backend stream error: 429 {"code":"user_rate_limit","error":"Daily credit limit reached.","limitKind":"total"}',
      }),
    ).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().intent).toBe("topup");
  });

  it("captures the org id from wrapped signed-in usage limit hits", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      organizationId: null,
      pendingInput: null,
    });

    expect(
      notifyMCPJamLimitError({
        message:
          'Backend stream error: 429 {"code":"user_rate_limit","error":"Daily credit limit reached.","limitKind":"total","organizationId":"org-a"}',
      }),
    ).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().organizationId).toBe("org-a");
  });

  it("does not open the modal for concurrency-throttle errors", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    expect(
      notifyMCPJamLimitError({
        code: "user_rate_limit",
        limitKind: "concurrency",
      }),
    ).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });

  it("defers opening while auth state is still loading", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "loading",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    expect(notifyMCPJamLimitError({ code: "mcpjam_rate_limit" })).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().hasPendingLimit).toBe(true);

    useMCPJamLimitDialogStore.getState().setAuthStatus("guest");
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().intent).toBe("guest");
    expect(useMCPJamLimitDialogStore.getState().hasPendingLimit).toBe(false);
  });

  it("resolves a deferred limit to topup when the user is signed in", () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "loading",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    expect(notifyMCPJamLimitError({ code: "user_rate_limit" })).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().hasPendingLimit).toBe(true);

    useMCPJamLimitDialogStore.getState().setAuthStatus("signedIn");
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().intent).toBe("topup");
  });

  it("detects limits from response clones without consuming the original body", async () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "guest",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    const response = new Response(
      JSON.stringify({
        code: "mcpjam_rate_limit",
        error: "Daily usage limit reached.",
        organizationId: "org-from-response",
      }),
      { status: 429 },
    );

    await expect(notifyMCPJamLimitErrorFromResponse(response)).resolves.toBe(
      true,
    );
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(useMCPJamLimitDialogStore.getState().organizationId).toBe(
      "org-from-response",
    );
    await expect(response.text()).resolves.toContain("mcpjam_rate_limit");
  });

  it("forwards limitKind from response payload so concurrency is suppressed", async () => {
    useMCPJamLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
      intent: null,
      pendingInput: null,
    });

    const response = new Response(
      JSON.stringify({
        code: "user_rate_limit",
        error: "Another credit-funded chat is finishing.",
        limitKind: "concurrency",
      }),
      { status: 429 },
    );

    await expect(notifyMCPJamLimitErrorFromResponse(response)).resolves.toBe(
      false,
    );
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });
});
