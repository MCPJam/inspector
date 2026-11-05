import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useConformanceInputs } from "../use-conformance-inputs";
import type { ConformanceProbes } from "../use-conformance-probes";

it("keeps merged inputs stable and retains local Tasks choices after shared inputs arrive", () => {
  const local: ConformanceProbes = {
    logProbe: { toolName: "draft-log" },
    tasksOverrides: { "tasks-inline-result": { toolName: "custom" } },
    logLevelOverride: { toolName: "loud", level: "error" },
  };
  const localFor = () => local;
  const { result, rerender } = renderHook(
    ({ shared }: { shared?: Record<string, ConformanceProbes> }) =>
      useConformanceInputs(shared, localFor),
    { initialProps: {} },
  );
  expect(result.current("alpha")).toBe(local);
  rerender({ shared: { alpha: { logProbe: { toolName: "saved-log" } } } });
  const merged = result.current("alpha");
  expect(merged).toEqual({ ...local, logProbe: { toolName: "saved-log" } });
  expect(result.current("alpha")).toBe(merged);
  rerender({ shared: {} });
  expect(result.current("constructor")).toBe(local);
});
