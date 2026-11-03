import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MCP_TASKS_CHECK_IDS } from "@mcpjam/sdk/browser";
import {
  probeKeyFor,
  probesAfterRun,
  probesApply,
  probesForRun,
  readStoredProbes,
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

  it("keeps each server's tools across a reload", () => {
    const { result } = renderHook(() => useConformanceProbeStore());
    act(() => result.current.setProbes("alpha", { logProbe }));

    expect(result.current.probesFor("alpha")).toEqual({ logProbe });
    expect(result.current.probesFor("beta")).toEqual({});
    expect(readStoredProbes("alpha")).toEqual({ logProbe });
  });

  it("keeps the output-check tool across a reload, alone", () => {
    const { result } = renderHook(() => useConformanceProbeStore());
    act(() => result.current.setProbes("alpha", { toolCallProbe }));
    expect(readStoredProbes("alpha")).toEqual({ toolCallProbe });
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

  it("keeps its answers across a reload, and only on the Tasks probe", () => {
    window.localStorage.setItem(
      "mcpjam.conformance.probes.v1:alpha",
      JSON.stringify({
        tasksProbe,
        logProbe: { ...logProbe, inputResponses: { confirm: true } },
      }),
    );
    expect(readStoredProbes("alpha")).toEqual({ tasksProbe, logProbe });
  });

  it("drops answers that are not an object", () => {
    window.localStorage.setItem(
      "mcpjam.conformance.probes.v1:alpha",
      JSON.stringify({ tasksProbe: { ...tasksProbe, inputResponses: [1] } }),
    );
    expect(readStoredProbes("alpha")).toEqual({
      tasksProbe: { toolName: "long-job", arguments: { seconds: 2 } },
    });
  });
});
