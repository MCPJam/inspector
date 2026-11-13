import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ hosted: false, flags: {} as Record<string, boolean | undefined> }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (key: string) => state.flags[key],
}));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));

import { useCopilotCliEnabled } from "../useCopilotCliEnabled";

const render = (hosted: boolean, flags: Record<string, boolean | undefined>) => {
  state.hosted = hosted;
  state.flags = flags;
  return renderHook(() => useCopilotCliEnabled()).result.current;
};

describe("useCopilotCliEnabled", () => {
  it("offers the template on a local Inspector once local Copilot is rolled out", () => {
    expect(render(false, { "local-copilot-cli-enabled": true })).toBe(true);
    expect(render(false, { "local-copilot-cli-enabled": false, "copilot-cli-harness": true })).toBe(false);
    expect(render(false, {})).toBeUndefined();
  });

  it("follows the hosted rollout alone when hosted", () => {
    expect(render(true, { "copilot-cli-harness": true })).toBe(true);
    expect(render(true, { "copilot-cli-harness": false, "local-copilot-cli-enabled": true })).toBe(false);
  });
});
