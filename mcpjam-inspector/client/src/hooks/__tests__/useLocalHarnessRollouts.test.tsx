import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_HARNESS_IDS,
  localHarnessRolloutFlag,
} from "@/shared/harness-descriptors";
import { CLIENT_FEATURE_FLAG_KEYS } from "@/shared/client-feature-flags";

const read = vi.hoisted(() => [] as string[]);
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (key: string) => {
    read.push(key);
    return key !== "local-codex-enabled";
  },
}));

import { useLocalHarnessRollouts } from "../useComputersEnabled";

describe("useLocalHarnessRollouts", () => {
  it("reads each local runtime's own rollout flag, and only those", () => {
    read.length = 0;
    const { result } = renderHook(() => useLocalHarnessRollouts());
    expect([...read].sort()).toEqual(LOCAL_HARNESS_IDS.map(localHarnessRolloutFlag).sort());
    for (const id of LOCAL_HARNESS_IDS) {
      expect(result.current[id]).toBe(localHarnessRolloutFlag(id) !== "local-codex-enabled");
    }
  });

  it("reads only flags the server evaluates for the client", () => {
    for (const id of LOCAL_HARNESS_IDS) {
      expect(CLIENT_FEATURE_FLAG_KEYS).toContain(localHarnessRolloutFlag(id));
    }
  });
});
