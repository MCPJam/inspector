import { describe, expect, it } from "vitest";
import type { EvalSuite } from "../../../evals/types";
import { suiteGenerateState } from "../suite-generate-state";

const suite = (overrides: Partial<EvalSuite>): EvalSuite => ({
  _id: "s_1",
  createdBy: "u",
  name: "Suite",
  description: "",
  configRevision: "r",
  environment: { servers: ["linear"] },
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe("suiteGenerateState", () => {
  it("is off when the suite has no servers", () => {
    const state = suiteGenerateState(
      suite({ environment: { servers: [] } }),
      new Set(),
      true,
    );
    expect(state.canGenerate).toBe(false);
  });

  it("names the servers to connect when it cannot connect them", () => {
    const state = suiteGenerateState(suite({}), new Set(), false);
    expect(state).toEqual({
      canGenerate: false,
      disabledReason: "Connect linear to generate cases for this suite.",
    });
  });

  it("is on when the servers are connected or can be", () => {
    expect(
      suiteGenerateState(suite({}), new Set(["linear"]), false).canGenerate,
    ).toBe(true);
    expect(suiteGenerateState(suite({}), new Set(), true).canGenerate).toBe(
      true,
    );
  });

  it("names the page's own place to attach a client when there is no suite", () => {
    expect(
      suiteGenerateState(null, new Set(), true, "Attach a client here."),
    ).toEqual({ canGenerate: false, disabledReason: "Attach a client here." });
  });
});
