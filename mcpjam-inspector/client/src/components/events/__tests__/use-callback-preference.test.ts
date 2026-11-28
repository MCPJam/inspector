import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  httpsReceiverOf,
  useCallbackPreference,
} from "../use-callback-preference";

const key = `mcpjam-events-callback:${JSON.stringify(["project", "Flights"])}`;

describe("useCallbackPreference", () => {
  afterEach(() => window.localStorage.clear());

  it("moves the saved receiver when a new one is remembered", () => {
    window.localStorage.setItem(key, "https://tunnel.example.com/");
    const { result } = renderHook(() =>
      useCallbackPreference("project", "Flights"),
    );
    expect(httpsReceiverOf(result.current.saved)).toBe(
      "https://tunnel.example.com/",
    );

    act(() => result.current.remember({ kind: "local" }));
    expect(result.current.saved.kind).toBe("local");
    expect(httpsReceiverOf(result.current.saved)).toBeUndefined();

    act(() =>
      result.current.remember({
        kind: "custom",
        baseUrl: "https://other.example.com/",
      }),
    );
    expect(httpsReceiverOf(result.current.saved)).toBe(
      "https://other.example.com/",
    );
  });

  it("keeps draft edits out of the saved receiver", () => {
    window.localStorage.setItem(key, "https://tunnel.example.com/");
    const { result } = renderHook(() =>
      useCallbackPreference("project", "Flights"),
    );
    act(() => result.current.setDraft({ kind: "custom", url: "http://" }));
    expect(httpsReceiverOf(result.current.saved)).toBe(
      "https://tunnel.example.com/",
    );
  });
});
