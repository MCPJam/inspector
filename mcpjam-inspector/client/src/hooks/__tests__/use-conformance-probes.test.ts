import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MCP_TASKS_CHECK_IDS } from "@mcpjam/sdk/browser";
import {
  LOG_LEVEL_ADVICE,
  readStoredProbes,
  probeInputStatus,
  probeKeyFor,
  probesAfterRun,
  probesApply,
  probesForRun,
  protocolProbesFor,
  protocolRunOptions,
  tasksProbeRuns,
  tasksRunOptions,
  useConformanceProbeStore,
} from "../use-conformance-probes";

const logProbe = { toolName: "echo", arguments: { message: "hi" } };
const inputRequiredProbe = { toolName: "ask" };
const tasksProbe = {
  toolName: "long-job",
  arguments: { seconds: 2 },
  inputResponses: { confirm: { action: "accept" } },
};
const toolCallProbe = { toolName: "weather", arguments: { city: "Lima" } };

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

  it("keeps the log tool for the log level advice alone", () => {
    // The logging check is left out, but the advice still calls the tool.
    expect(
      probesForRun({ logProbe }, ["ping"], "2026-07-28", [
        "readiness-log-level-filtering",
      ]),
    ).toEqual({ logProbe });
    // With the advice left out too, it is not sent.
    expect(probesForRun({ logProbe }, ["ping"], "2026-07-28", [])).toEqual({});
  });

  it("maps each check to the tool it calls", () => {
    expect(probeKeyFor("modern-logs-require-log-level")).toBe("logProbe");
    expect(probeKeyFor("readiness-log-level-filtering")).toBe("logProbe");
    expect(probeKeyFor("modern-undeclared-capability-error")).toBe(
      "inputRequiredProbe",
    );
    expect(probeKeyFor("tasks-update-ack-shape")).toBe("tasksProbe");
    expect(probeKeyFor("modern-tool-output-schema-conformant")).toBe(
      "toolCallProbe",
    );
    expect(probeKeyFor("ping")).toBeUndefined();
  });

  it("sends the output-check tool only when that check runs", () => {
    expect(
      probesForRun(
        { logProbe, toolCallProbe },
        ["modern-tool-output-schema-conformant"],
        "2026-07-28",
        [],
      ),
    ).toEqual({ toolCallProbe });
    expect(
      probesForRun(
        { toolCallProbe },
        ["modern-logs-require-log-level"],
        "2026-07-28",
        [],
      ),
    ).toEqual({});
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
        { protocol: ["modern-logs-require-log-level"] },
        "2026-07-28",
      ),
    ).toEqual({ logProbe, inputRequiredProbe });
  });

  it("drops a tool cleared for a check that ran", () => {
    expect(probesAfterRun(saved, {}, {}, "2026-07-28")).toEqual({});
  });

  it("keeps the Tasks tool by the Tasks picks, on any pin", () => {
    const other = { toolName: "other-job" };
    // Tasks left out: the saved tool stays, the draft's is not saved.
    expect(
      probesAfterRun(
        { tasksProbe },
        { tasksProbe: other },
        { tasks: [] },
        "auto",
      ),
    ).toEqual({ tasksProbe });
    // Tasks ran: the draft's tool is saved.
    expect(
      probesAfterRun({ tasksProbe }, { tasksProbe: other }, {}, "auto"),
    ).toEqual({ tasksProbe: other });
  });
});

describe("useConformanceProbeStore", () => {
  beforeEach(() => window.localStorage.clear());
  it("keeps protocol drafts in session and persists Tasks settings", () => {
    window.localStorage.setItem(
      "mcpjam.conformance.probes.v1:alpha",
      JSON.stringify({ logProbe }),
    );
    const { result, unmount } = renderHook(() => useConformanceProbeStore());
    expect(result.current.probesFor("alpha")).toEqual({});
    act(() => result.current.setProbes("alpha", { tasksProbe }));
    expect(result.current.probesFor("alpha")).toEqual({ tasksProbe });
    expect(result.current.probesFor("beta")).toEqual({});
    expect(
      JSON.parse(
        window.localStorage.getItem("mcpjam.conformance.probes.v1:alpha")!,
      ),
    ).toEqual({ tasksProbe });
    unmount();
    const next = renderHook(() => useConformanceProbeStore());
    expect(next.result.current.probesFor("alpha")).toEqual({ tasksProbe });
  });
  it("isolates names inherited from Object", () => {
    const { result } = renderHook(() => useConformanceProbeStore());
    act(() => result.current.setProbes("constructor", { logProbe }));
    expect(result.current.probesFor("constructor")).toEqual({ logProbe });
    expect(result.current.probesFor("__proto__")).toEqual({});
  });
});

describe("Tasks probe", () => {
  beforeEach(() => window.localStorage.clear());

  it("is called only for the Tasks checks that need a task", () => {
    expect(probeKeyFor("tasks-update-ack-shape")).toBe("tasksProbe");
    // Reads the wire the server negotiated; never calls the tool.
    expect(probeKeyFor("tasks-wire-resolvable")).toBeUndefined();
    expect(tasksProbeRuns(undefined)).toBe(true);
    expect(tasksProbeRuns(["tasks-wire-resolvable"])).toBe(false);
  });

  it("classifies every Tasks check as calling the tool or not", () => {
    // Mirrors the SDK runner. A new check fails here until it is placed.
    const callsTool = [
      "tasks-result-type-discipline",
      "tasks-undeclared-creation-refused",
      "tasks-undeclared-capability-rejected",
      "tasks-ttl-shape",
      "tasks-inline-result",
      "tasks-mcp-name-routing",
      "tasks-status-payload-shape",
      "tasks-cancel-ack-shape",
      "tasks-update-ack-shape",
      "tasks-ttl-integer-shape",
      "tasks-undeclared-capability-names-requirements",
    ];
    // Read the negotiated wire and declarations, or probe an unknown task id.
    const noTool = [
      "tasks-wire-resolvable",
      "tasks-declaration-hygiene",
      "tasks-invalid-task-id-rejected",
    ];
    expect([...callsTool, ...noTool].sort()).toEqual(
      [...MCP_TASKS_CHECK_IDS].sort(),
    );
    for (const id of callsTool) expect(probeKeyFor(id)).toBe("tasksProbe");
    for (const id of noTool) expect(probeKeyFor(id)).toBeUndefined();
  });

  it("sends the answers only when the update acknowledgement check runs", () => {
    expect(
      tasksRunOptions({ tasksProbe }, { tasks: ["tasks-cancel-ack-shape"] }),
    ).toEqual({
      checkIds: ["tasks-cancel-ack-shape"],
      toolName: "long-job",
      toolArguments: { seconds: 2 },
    });
    expect(
      tasksRunOptions({ tasksProbe }, { tasks: ["tasks-update-ack-shape"] })
        .inputResponses,
    ).toEqual({ confirm: { action: "accept" } });
  });

  it("stays out of the protocol run", () => {
    expect(
      probesForRun({ logProbe, tasksProbe }, undefined, "2026-07-28"),
    ).toEqual({ logProbe });
  });

  it("sends the tool, its arguments and the answers with the Tasks run", () => {
    expect(tasksRunOptions({ tasksProbe }, undefined)).toEqual({
      toolName: "long-job",
      toolArguments: { seconds: 2 },
      inputResponses: { confirm: { action: "accept" } },
    });
    // No picked check calls it: only the picks go.
    expect(
      tasksRunOptions({ tasksProbe }, { tasks: ["tasks-wire-resolvable"] }),
    ).toEqual({ checkIds: ["tasks-wire-resolvable"] });
  });

});

describe("Tasks per-check settings", () => {
  it("sends only selected overrides and uses the update override answers", () => {
    const probes = {
      tasksProbe,
      tasksOverrides: {
        "tasks-inline-result": {
          toolName: "finish",
          arguments: { fast: true },
        },
        "tasks-update-ack-shape": {
          toolName: "ask",
          inputResponses: { name: "Ada" },
        },
      },
    };
    expect(tasksRunOptions(probes, { tasks: ["tasks-inline-result"] })).toEqual(
      {
        checkIds: ["tasks-inline-result"],
        toolName: tasksProbe.toolName,
        toolArguments: tasksProbe.arguments,
        checkOverrides: {
          "tasks-inline-result": {
            toolName: "finish",
            toolArguments: { fast: true },
          },
        },
      },
    );
    expect(
      tasksRunOptions(probes, { tasks: ["tasks-update-ack-shape"] })
        .inputResponses,
    ).toEqual({ name: "Ada" });
    expect(
      tasksRunOptions(
        {
          tasksProbe,
          tasksOverrides: { "tasks-update-ack-shape": { toolName: "ask" } },
        },
        {},
      ).inputResponses,
    ).toBeUndefined();
  });
  it("keeps unselected overrides through storage and reads old defaults with their answers", () => {
    const probes = {
      tasksProbe,
      tasksOverrides: {
        "tasks-inline-result": { toolName: "finish" },
        "tasks-update-ack-shape": { toolName: "" },
      },
    };
    const store = renderHook(() => useConformanceProbeStore());
    act(() =>
      store.result.current.setProbes(
        "overrides-test",
        probesAfterRun(
          {},
          probes,
          { tasks: ["tasks-wire-resolvable"] },
          "auto",
        ),
      ),
    );
    expect(readStoredProbes("overrides-test").tasksOverrides).toEqual(
      probes.tasksOverrides,
    );
    window.localStorage.setItem(
      "mcpjam.conformance.probes.v1:old-test",
      JSON.stringify({ tasksProbe }),
    );
    expect(readStoredProbes("old-test")).toEqual({ tasksProbe });
  });
});

describe("the log level filtering advice's own tool", () => {
  const logLevelOverride = { toolName: "loud", level: "error" as const };
  const pick = (protocol?: string[], protocolAdvice?: string[]) =>
    ({ protocol, protocolAdvice }) as Parameters<typeof protocolRunOptions>[1];

  it("is sent with the run while the logging check and the advice run", () => {
    expect(
      protocolRunOptions(
        { logProbe, logLevelOverride },
        undefined,
        "2026-07-28",
      ).probes,
    ).toEqual({ logProbe, logLevelOverride });
  });

  it("is not sent when the advice is left out", () => {
    expect(
      protocolRunOptions(
        { logProbe, logLevelOverride },
        pick(undefined, []),
        "2026-07-28",
      ).probes,
    ).toEqual({ logProbe });
  });

  it("is ignored while the logging check is left out: the advice uses the shared tool", () => {
    const probes = { logProbe, logLevelOverride };
    expect(
      protocolRunOptions(probes, pick(["tools-list"]), "2026-07-28").probes,
    ).toEqual({ logProbe });
    expect(protocolProbesFor(probes, ["tools-list"])).toEqual({ logProbe });
    expect(
      probeInputStatus(
        LOG_LEVEL_ADVICE,
        protocolProbesFor({ logLevelOverride }, ["tools-list"]),
      ),
    ).toBe("missing");
  });

  it("keeps the advice out of the run while its own tool is not chosen", () => {
    const probes = { logProbe, logLevelOverride: { toolName: "" } };
    const options = protocolRunOptions(probes, undefined, "2026-07-28");
    expect(options.probes).toEqual({ logProbe });
    expect(options.readinessIds).toBeDefined();
    expect(options.readinessIds).not.toContain(LOG_LEVEL_ADVICE);
    expect(options.readinessIds).toContain(
      "readiness-tool-order-deterministic",
    );
    expect(probeInputStatus(LOG_LEVEL_ADVICE, probes)).toBe("missing");
  });

  it("is kept after a run and through storage, with its level", () => {
    const after = probesAfterRun({}, { logLevelOverride }, undefined, "auto");
    expect(after).toEqual({ logLevelOverride });
    const store = renderHook(() => useConformanceProbeStore());
    act(() => store.result.current.setProbes("log-override-test", after));
    expect(readStoredProbes("log-override-test")).toEqual({ logLevelOverride });
  });
});
