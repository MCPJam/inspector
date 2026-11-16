import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useServerForm } from "../use-server-form";

vi.mock("@/hooks/use-app-state", () => ({}));
vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));
vi.mock("@/lib/oauth/mcp-oauth", () => ({
  hasOAuthConfig: vi.fn().mockReturnValue(false),
  getStoredTokens: vi.fn().mockReturnValue(null),
}));

describe.each(["http", "stdio"] as const)("%s request timeout", (type) => {
  const formWithTimeout = (value: string) => {
    const { result } = renderHook(() => useServerForm());
    act(() => {
      result.current.setName("Test server");
      result.current.setType(type);
      result.current.setUrl("https://example.com/mcp");
      result.current.setCommandInput("node server.js");
      result.current.setRequestTimeout(value);
    });
    return result;
  };

  it.each([
    ["", undefined],
    ["  ", undefined],
    ["1000", 1000],
    ["600000", 600000],
    ["30000", 30000],
    ["1e3", 1000],
  ])("validates and builds %j without changing its value", (input, expected) => {
    const result = formWithTimeout(input);
    expect(result.current.validateForm()).toBeNull();
    expect(result.current.buildFormData().requestTimeout).toBe(expected);
  });

  it.each([
    "0",
    "-1000",
    "999",
    "600001",
    "1500",
    "1000.5",
    "NaN",
    "Infinity",
    "1000ms",
  ])("rejects %j before building a submission", (input) => {
    const result = formWithTimeout(input);
    expect(result.current.validateForm()).toBe(
      "Enter a timeout from 1000 to 600000 ms in steps of 1000, or leave it blank to use the default.",
    );
  });
});
