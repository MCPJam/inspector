import { beforeEach, describe, expect, it } from "vitest";
import {
  isMCPJamModelLimitError,
  notifyGuestLimitError,
  notifyGuestLimitErrorFromResponse,
} from "../guest-limit";
import { useGuestLimitDialogStore } from "@/stores/guest-limit-dialog-store";

beforeEach(() => {
  useGuestLimitDialogStore.setState({
    authStatus: "loading",
    hasPendingLimit: false,
    isOpen: false,
  });
});

describe("isMCPJamModelLimitError", () => {
  it("detects the canonical rate-limit code", () => {
    expect(isMCPJamModelLimitError({ code: "mcpjam_rate_limit" })).toBe(true);
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
    useGuestLimitDialogStore.setState({
      authStatus: "guest",
      hasPendingLimit: false,
      isOpen: false,
    });

    expect(notifyGuestLimitError({ code: "mcpjam_rate_limit" })).toBe(true);
    expect(useGuestLimitDialogStore.getState().isOpen).toBe(true);
  });

  it("defers opening while auth state is still loading", () => {
    useGuestLimitDialogStore.setState({
      authStatus: "loading",
      hasPendingLimit: false,
      isOpen: false,
    });

    expect(notifyGuestLimitError({ code: "mcpjam_rate_limit" })).toBe(true);
    expect(useGuestLimitDialogStore.getState().isOpen).toBe(false);
    expect(useGuestLimitDialogStore.getState().hasPendingLimit).toBe(true);

    useGuestLimitDialogStore.getState().setAuthStatus("guest");
    expect(useGuestLimitDialogStore.getState().isOpen).toBe(true);
    expect(useGuestLimitDialogStore.getState().hasPendingLimit).toBe(false);
  });

  it("does not open for signed-in users", () => {
    useGuestLimitDialogStore.setState({
      authStatus: "signedIn",
      hasPendingLimit: false,
      isOpen: false,
    });

    expect(notifyGuestLimitError({ code: "mcpjam_rate_limit" })).toBe(true);
    expect(useGuestLimitDialogStore.getState().isOpen).toBe(false);
  });

  it("detects limits from response clones without consuming the original body", async () => {
    useGuestLimitDialogStore.setState({
      authStatus: "guest",
      hasPendingLimit: false,
      isOpen: false,
    });

    const response = new Response(
      JSON.stringify({
        code: "mcpjam_rate_limit",
        error: "Daily usage limit reached.",
      }),
      { status: 429 },
    );

    await expect(notifyGuestLimitErrorFromResponse(response)).resolves.toBe(
      true,
    );
    expect(useGuestLimitDialogStore.getState().isOpen).toBe(true);
    await expect(response.text()).resolves.toContain("mcpjam_rate_limit");
  });
});
