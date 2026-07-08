import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_XAA_RUN_SETTINGS,
  useXaaRunSettings,
} from "../useXaaRunSettings";

const RUN_SETTINGS_KEY = "mcpjam-xaa-run-settings/v1";
const LEGACY_PROFILE_KEY = "mcpjam-xaa-debugger-profile/v1";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("useXaaRunSettings", () => {
  it("defaults to the built-in identity and mode with no stored keys", () => {
    const { result } = renderHook(() => useXaaRunSettings());
    expect(result.current.userId).toBe(DEFAULT_XAA_RUN_SETTINGS.userId);
    expect(result.current.email).toBe(DEFAULT_XAA_RUN_SETTINGS.email);
    expect(result.current.negativeTestMode).toBe(
      DEFAULT_XAA_RUN_SETTINGS.negativeTestMode,
    );
    expect(result.current.isDefaultIdentity).toBe(true);
  });

  it("migrates identity + mode from the legacy debugger profile once", () => {
    localStorage.setItem(
      LEGACY_PROFILE_KEY,
      JSON.stringify({
        serverUrl: "https://legacy.example.com",
        userId: "legacy-user",
        email: "legacy@example.com",
        negativeTestMode: "wrong_audience",
      }),
    );

    const { result } = renderHook(() => useXaaRunSettings());

    expect(result.current.userId).toBe("legacy-user");
    expect(result.current.email).toBe("legacy@example.com");
    expect(result.current.negativeTestMode).toBe("wrong_audience");
    expect(result.current.isDefaultIdentity).toBe(false);

    // The new key is now seeded from the legacy values.
    const stored = JSON.parse(localStorage.getItem(RUN_SETTINGS_KEY) ?? "{}");
    expect(stored).toMatchObject({
      userId: "legacy-user",
      email: "legacy@example.com",
      negativeTestMode: "wrong_audience",
    });
  });

  it("does not re-seed from the legacy profile once the new key exists", () => {
    localStorage.setItem(
      RUN_SETTINGS_KEY,
      JSON.stringify({
        userId: "kept-user",
        email: "kept@example.com",
        negativeTestMode: "expired",
      }),
    );
    // A stale legacy profile with different values must be ignored.
    localStorage.setItem(
      LEGACY_PROFILE_KEY,
      JSON.stringify({
        userId: "legacy-user",
        email: "legacy@example.com",
        negativeTestMode: "wrong_audience",
      }),
    );

    const { result } = renderHook(() => useXaaRunSettings());

    expect(result.current.userId).toBe("kept-user");
    expect(result.current.email).toBe("kept@example.com");
    expect(result.current.negativeTestMode).toBe("expired");
  });

  it("sanitizes an invalid stored negativeTestMode to the default", () => {
    localStorage.setItem(
      RUN_SETTINGS_KEY,
      JSON.stringify({
        userId: "u",
        email: "e@example.com",
        negativeTestMode: "not-a-real-mode",
      }),
    );

    const { result } = renderHook(() => useXaaRunSettings());
    expect(result.current.negativeTestMode).toBe(
      DEFAULT_XAA_RUN_SETTINGS.negativeTestMode,
    );
  });

  it("persists identity + mode updates and sanitizes the mode setter", () => {
    const { result } = renderHook(() => useXaaRunSettings());

    act(() => {
      result.current.setIdentity({ userId: "custom", email: "c@example.com" });
    });
    act(() => {
      result.current.setNegativeTestMode("scope_denial");
    });

    expect(result.current.userId).toBe("custom");
    expect(result.current.email).toBe("c@example.com");
    expect(result.current.negativeTestMode).toBe("scope_denial");
    expect(result.current.isDefaultIdentity).toBe(false);

    const stored = JSON.parse(localStorage.getItem(RUN_SETTINGS_KEY) ?? "{}");
    expect(stored).toMatchObject({
      userId: "custom",
      email: "c@example.com",
      negativeTestMode: "scope_denial",
    });
  });
});
