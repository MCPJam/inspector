import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  hosted: false,
  flags: {} as Record<string, boolean | undefined>,
  reads: [] as string[],
  availability: {} as Record<string, boolean | undefined>,
}));

vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (key: string) => {
    state.reads.push(key);
    return state.flags[key];
  },
}));
vi.mock("../useHostedBrowserAvailability", () => ({
  useHostedBrowserAvailable: (surface: string) => state.availability[surface],
}));

beforeEach(() => {
  vi.resetModules();
  state.flags = {};
  state.reads = [];
  state.availability = {};
});

describe("WebMCP visibility, local", () => {
  beforeEach(() => {
    state.hosted = false;
  });

  it("is always visible, whatever any flag or backend says", async () => {
    state.flags = {
      "hosted-browser-enabled": false,
      "webmcp-inspector-enabled": false,
      "sandbox-images-enabled": false,
    };
    // A local inspector may run against no backend; it never asks one.
    state.availability = { inspector: false };
    const hooks = await import("../useWebmcpInspectorEnabled");
    const { result } = renderHook(() => ({
      state: hooks.useWebmcpInspectorEnabledState(),
      visible: hooks.useWebmcpInspectorEnabled(),
    }));
    expect(result.current).toEqual({ state: true, visible: true });
    expect(state.reads).toEqual([]);
  });
});

describe("WebMCP visibility, hosted", () => {
  beforeEach(() => {
    state.hosted = true;
  });

  it.each([true, false, undefined])(
    "follows the backend's answer for the inspector (%s), preserving hydration",
    async (available) => {
      // The flag says yes either way; only the backend's answer, which also
      // knows whether a desktop would come up, decides.
      state.flags = { "hosted-browser-enabled": true };
      state.availability = { inspector: available, tools: true };
      const hooks = await import("../useWebmcpInspectorEnabled");
      const { result } = renderHook(() => ({
        state: hooks.useWebmcpInspectorEnabledState(),
        visible: hooks.useWebmcpInspectorEnabled(),
      }));
      expect(result.current).toEqual({
        state: available,
        visible: available === true,
      });
    },
  );

  it("hides the tab the flag would show when the deployment cannot launch it", async () => {
    state.flags = { "hosted-browser-enabled": true };
    state.availability = { inspector: false };
    const { useWebmcpInspectorEnabled } =
      await import("../useWebmcpInspectorEnabled");
    const { result } = renderHook(useWebmcpInspectorEnabled);
    expect(result.current).toBe(false);
  });

  it("needs neither Computers nor the legacy WebMCP flag", async () => {
    state.availability = { inspector: true };
    const { useWebmcpInspectorEnabled } =
      await import("../useWebmcpInspectorEnabled");
    const { result } = renderHook(useWebmcpInspectorEnabled);
    expect(result.current).toBe(true);
  });
});
