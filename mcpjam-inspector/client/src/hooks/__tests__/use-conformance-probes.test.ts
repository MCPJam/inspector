import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  probeKeyFor,
  probesAfterRun,
  probesApply,
  probesForRun,
  readStoredProbes,
  useConformanceProbeStore,
} from "../use-conformance-probes";

const logProbe = { toolName: "echo", arguments: { message: "hi" } };
const inputRequiredProbe = { toolName: "ask" };

describe("probesForRun", () => {
  it("sends every probe when every check runs", () => {
    expect(
      probesForRun({ logProbe, inputRequiredProbe }, undefined, "2026-07-28"),
    ).toEqual({ logProbe, inputRequiredProbe });
  });

  it("sends none on a run these checks do not apply to", () => {
    // Auto never reaches 2026-07-28, and a legacy pin skips its checks.
    for (const pin of ["auto", "2025-11-25"] as const) {
      expect(probesApply(pin)).toBe(false);
      expect(probesForRun({ logProbe }, undefined, pin)).toEqual({});
    }
    expect(probesApply("2026-07-28")).toBe(true);
  });

  it("drops a probe whose checks are all left out", () => {
    expect(
      probesForRun(
        { logProbe, inputRequiredProbe },
        ["modern-logs-require-log-level"],
        "2026-07-28",
      ),
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

describe("probesAfterRun", () => {
  const saved = { inputRequiredProbe };

  it("keeps the draft's tool only for checks that ran", () => {
    const draft = { logProbe, inputRequiredProbe: { toolName: "other" } };
    // Only a logging check ran: the new input tool, picked for a check left
    // out, is not saved; the saved one stays.
    expect(
      probesAfterRun(
        saved,
        draft,
        ["modern-logs-require-log-level"],
        "2026-07-28",
      ),
    ).toEqual({ logProbe, inputRequiredProbe });
  });

  it("drops a tool cleared for a check that ran", () => {
    expect(probesAfterRun(saved, {}, undefined, "2026-07-28")).toEqual({});
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

  it("reads storage once per server", () => {
    window.localStorage.setItem(
      "mcpjam.conformance.probes.v1:alpha",
      JSON.stringify({ logProbe }),
    );
    const { result } = renderHook(() => useConformanceProbeStore());
    const first = result.current.probesFor("alpha");
    // Same object on every read, until a write.
    expect(result.current.probesFor("alpha")).toBe(first);
    expect(first).toEqual({ logProbe });
  });

  it("keeps a server named like an object property apart", () => {
    const { result } = renderHook(() => useConformanceProbeStore());
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(result.current.probesFor(name)).toEqual({});
    }
    act(() => result.current.setProbes("constructor", { logProbe }));
    expect(result.current.probesFor("constructor")).toEqual({ logProbe });
    expect(result.current.probesFor("__proto__")).toEqual({});
  });

  it("keeps the log probe's level and drops one it cannot send", () => {
    window.localStorage.setItem(
      "mcpjam.conformance.probes.v1:alpha",
      JSON.stringify({
        logProbe: { ...logProbe, level: "info" },
        inputRequiredProbe: { ...inputRequiredProbe, level: "info" },
      }),
    );
    expect(readStoredProbes("alpha")).toEqual({
      logProbe: { ...logProbe, level: "info" },
      inputRequiredProbe,
    });

    window.localStorage.setItem(
      "mcpjam.conformance.probes.v1:alpha",
      JSON.stringify({ logProbe: { ...logProbe, level: "loud" } }),
    );
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
