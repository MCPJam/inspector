import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  probeKeyFor,
  probesForRun,
  readStoredProbes,
  useConformanceProbeStore,
} from "../use-conformance-probes";

const logProbe = { toolName: "echo", arguments: { message: "hi" } };
const inputRequiredProbe = { toolName: "ask" };

describe("probesForRun", () => {
  it("sends every probe when every check runs", () => {
    expect(probesForRun({ logProbe, inputRequiredProbe }, undefined)).toEqual({
      logProbe,
      inputRequiredProbe,
    });
  });

  it("drops a probe whose checks are all left out", () => {
    expect(
      probesForRun({ logProbe, inputRequiredProbe }, [
        "modern-log-level-filtering",
      ]),
    ).toEqual({ logProbe });
  });

  it("maps each check to the tool it calls", () => {
    expect(probeKeyFor("modern-logs-require-log-level")).toBe("logProbe");
    expect(probeKeyFor("modern-undeclared-capability-error")).toBe(
      "inputRequiredProbe",
    );
    expect(probeKeyFor("ping")).toBeUndefined();
  });
});

describe("useConformanceProbeStore", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps each server's tools across a reload", () => {
    const { result } = renderHook(() => useConformanceProbeStore());
    act(() => result.current.setProbes("alpha", { logProbe }));

    expect(result.current.probesFor("alpha")).toEqual({ logProbe });
    expect(result.current.probesFor("beta")).toEqual({});
    expect(readStoredProbes("alpha")).toEqual({ logProbe });
  });

  it("ignores a stored entry that is not a probe", () => {
    window.localStorage.setItem(
      "mcpjam.conformance.probes.v1:alpha",
      JSON.stringify({ logProbe: { toolName: "" }, inputRequiredProbe }),
    );
    expect(readStoredProbes("alpha")).toEqual({ inputRequiredProbe });
  });
});
