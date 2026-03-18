import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-app-state", () => ({}));
vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));
vi.mock("@/lib/oauth/mcp-oauth", () => ({
  hasOAuthConfig: vi.fn().mockReturnValue(false),
  getStoredTokens: vi.fn().mockReturnValue(null),
}));

import { useServerForm } from "../use-server-form";

describe("useServerForm", () => {
  it("rejects malformed HTTP URLs even when HTTPS is optional", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("Test server");
      result.current.setUrl("foo");
    });

    expect(result.current.validateForm()).toBe("Invalid URL format");
  });

  it("allows valid HTTP URLs when HTTPS is not required", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("Test server");
      result.current.setUrl("http://example.com/mcp");
    });

    expect(result.current.validateForm()).toBeNull();
  });

  it("still enforces HTTPS when explicitly required", () => {
    const { result } = renderHook(() =>
      useServerForm(undefined, { requireHttps: true }),
    );

    act(() => {
      result.current.setName("Test server");
      result.current.setUrl("http://example.com/mcp");
    });

    expect(result.current.validateForm()).toBe("HTTPS is required");
  });
});
