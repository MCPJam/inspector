import { describe, expect, it } from "vitest";
import { readRunExecutionEngine } from "../run-execution-engine";

describe("readRunExecutionEngine", () => {
  it("prefers the top-level engine over the snapshot", () => {
    expect(
      readRunExecutionEngine({
        executionEngine: "harness:codex",
        configSnapshot: { executionEngine: "emulated" },
      } as never),
    ).toBe("harness:codex");
  });

  it("falls back to the snapshot", () => {
    expect(
      readRunExecutionEngine({
        configSnapshot: { executionEngine: "emulated" },
      } as never),
    ).toBe("emulated");
  });

  it("reports an unrecorded engine as unknown", () => {
    expect(readRunExecutionEngine({} as never)).toBeUndefined();
  });
});
