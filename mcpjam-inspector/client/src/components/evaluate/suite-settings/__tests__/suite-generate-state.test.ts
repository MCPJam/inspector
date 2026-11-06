import { describe, expect, it } from "vitest";
import type { EvalSuite } from "@/components/evals/types";
import { suiteGenerateState } from "../suite-generate-state";

const base: EvalSuite = {
  _id: "s1",
  createdBy: "u",
  name: "Suite",
  description: "",
  configRevision: "r",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
};
const target = (serverNames: string[]) => ({
  environmentId: "e1",
  hostName: null,
  serverNames,
  pluginVersionCount: 0,
});

describe("suiteGenerateState (C-4)", () => {
  it("refuses an environment suite with no runnable environment", () => {
    const suite = {
      ...base,
      environmentIds: ["e1"],
      environmentTargets: [target([])],
    };
    expect(suiteGenerateState(suite, new Set(), false)).toEqual({
      canGenerate: false,
      disabledReason:
        "None of this suite's environments has servers. Pick a server group in suite settings.",
    });
  });

  it("allows an environment suite whatever the browser has connected", () => {
    const suite = {
      ...base,
      environmentIds: ["e1"],
      environmentTargets: [target(["excalidraw"])],
    };
    expect(suiteGenerateState(suite, new Set(), false).canGenerate).toBe(true);
  });

  it("refuses a suite with no servers, or no suite at all", () => {
    const refused = {
      canGenerate: false,
      disabledReason:
        "Attach a client in the suite header before generating cases.",
    };
    expect(suiteGenerateState(base, new Set(), true)).toEqual(refused);
    expect(suiteGenerateState(null, new Set(), true)).toEqual(refused);
  });

  it("names missing servers when it cannot connect them", () => {
    const suite = { ...base, environment: { servers: ["a", "b"] } };
    expect(suiteGenerateState(suite, new Set(["a"]), false)).toEqual({
      canGenerate: false,
      disabledReason: "Connect b to generate cases for this suite.",
    });
  });

  it("connects missing servers when it can", () => {
    const suite = { ...base, environment: { servers: ["a"] } };
    expect(suiteGenerateState(suite, new Set(), true)).toEqual({
      canGenerate: true,
      disabledReason:
        "Connects the suite’s MCP servers if needed, then creates suggested test cases.",
    });
  });

  it("allows a suite whose servers are all connected", () => {
    const suite = { ...base, environment: { servers: ["a"] } };
    expect(suiteGenerateState(suite, new Set(["a"]), false).canGenerate).toBe(
      true,
    );
  });
});
