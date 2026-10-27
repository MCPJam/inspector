import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  readStoredProbes,
  useConformanceProbes,
} from "../use-conformance-probes";

const KEY = (server: string) => `mcpjam.conformance.probes.v1:${server}`;

afterEach(() => {
  window.localStorage.clear();
});

describe("useConformanceProbes", () => {
  it("saves per server and loads each server's own choice on a switch", () => {
    const { result, rerender } = renderHook(
      ({ server }) => useConformanceProbes(server),
      { initialProps: { server: "alpha" } },
    );
    act(() => {
      result.current.setProbes({ logProbe: { toolName: "emit-logs" } });
    });
    expect(JSON.parse(window.localStorage.getItem(KEY("alpha"))!)).toEqual({
      logProbe: { toolName: "emit-logs" },
    });

    rerender({ server: "beta" });
    expect(result.current.probes).toEqual({});

    rerender({ server: "alpha" });
    expect(result.current.probes).toEqual({
      logProbe: { toolName: "emit-logs" },
    });
  });

  it("removes the stored entry when every probe is cleared", () => {
    window.localStorage.setItem(
      KEY("alpha"),
      JSON.stringify({ logProbe: { toolName: "emit-logs" } }),
    );
    const { result } = renderHook(() => useConformanceProbes("alpha"));
    act(() => {
      result.current.setProbes({});
    });
    expect(window.localStorage.getItem(KEY("alpha"))).toBeNull();
  });

  it("drops malformed stored probes instead of sending them", () => {
    window.localStorage.setItem(
      KEY("alpha"),
      JSON.stringify({
        logProbe: { toolName: "" },
        inputRequiredProbe: { toolName: "ask-user", arguments: [1] },
      }),
    );
    expect(readStoredProbes("alpha")).toEqual({});

    window.localStorage.setItem(KEY("alpha"), "{not json");
    expect(readStoredProbes("alpha")).toEqual({});
  });
});
