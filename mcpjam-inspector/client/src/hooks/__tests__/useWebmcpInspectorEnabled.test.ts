import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  hosted: false,
  flags: {} as Record<string, boolean | undefined>,
  reads: [] as string[],
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

describe.each([false, true])("WebMCP visibility, hosted=%s", (hosted) => {
  beforeEach(() => {
    vi.resetModules();
    state.hosted = hosted;
    state.flags = {};
    state.reads = [];
  });

  it.each([true, false, undefined])(
    "uses only the deployment's Browser flag (%s), preserving hydration",
    async (enabled) => {
      const key = hosted ? "hosted-browser-enabled" : "local-browser-enabled";
      const other = hosted ? "local-browser-enabled" : "hosted-browser-enabled";
      state.flags = {
        [key]: enabled,
        [other]: true,
        "webmcp-inspector-enabled": true,
        "computers-enabled": true,
      };
      const hooks = await import("../useWebmcpInspectorEnabled");
      expect(hooks.WEBMCP_INSPECTOR_FEATURE_FLAG).toBe(key);
      const { result } = renderHook(() => ({
        state: hooks.useWebmcpInspectorEnabledState(),
        visible: hooks.useWebmcpInspectorEnabled(),
      }));
      expect(result.current).toEqual({
        state: enabled,
        visible: enabled === true,
      });
      expect(new Set(state.reads)).toEqual(new Set([key]));
    },
  );

  it("needs neither Computers nor the legacy WebMCP flag", async () => {
    const key = hosted ? "hosted-browser-enabled" : "local-browser-enabled";
    state.flags[key] = true;
    const { useWebmcpInspectorEnabled } = await import(
      "../useWebmcpInspectorEnabled"
    );
    const { result } = renderHook(useWebmcpInspectorEnabled);
    expect(result.current).toBe(true);
  });
});
