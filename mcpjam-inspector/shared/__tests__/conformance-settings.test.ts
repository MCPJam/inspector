import { describe, expect, it } from "vitest";
import {
  MCP_CHECK_IDS,
  MCP_TASKS_CHECK_IDS,
  type MCPCheckId,
} from "@mcpjam/sdk/browser";
import {
  conformanceSuiteConfigs,
  decodeStoredProbes,
  encodeStoredProbes,
  isSelected,
  protocolProbeFields,
  protocolSdkFields,
  storedSelection,
  tasksSdkFields,
  withoutTaskAnswersCheck,
  type ConformanceProbes,
  type ConformanceSelection,
} from "../conformance-settings";

const echo = { toolName: "echo", arguments: { text: "hi" } };
const createTask = { toolName: "create_task", arguments: { n: 1 } };

/** Ids in the catalog's order, which is the order a runnable selection keeps. */
function inCatalogOrder(ids: string[]): string[] {
  return MCP_CHECK_IDS.filter((id) => ids.includes(id));
}

describe("protocolSdkFields", () => {
  it("hands the output-schema check's tool to the SDK as a tool-call fixture", () => {
    expect(
      protocolSdkFields({
        checkIds: ["modern-tool-output-schema-conformant"],
        toolCallProbe: echo,
      }),
    ).toEqual({
      checkIds: ["modern-tool-output-schema-conformant"],
      fixtures: { toolCalls: [echo] },
    });
  });

  it("passes the log and input probes through under their own names", () => {
    const loud = { toolName: "loud", level: "error" as const };
    expect(
      protocolSdkFields({
        readinessIds: [],
        logProbe: echo,
        logLevelFilteringProbe: loud,
        inputRequiredProbe: echo,
      }),
    ).toEqual({
      readinessIds: [],
      logProbe: echo,
      logLevelFilteringProbe: loud,
      inputRequiredProbe: echo,
    });
  });

  it("leaves out every field the request did not set", () => {
    expect(protocolSdkFields({})).toEqual({});
  });
});

describe("protocolProbeFields", () => {
  it("sends the advice's own log tool as logLevelFilteringProbe and no Tasks tool", () => {
    expect(
      protocolProbeFields({
        logProbe: echo,
        logLevelOverride: { toolName: "loud", level: "error" },
        tasksProbe: createTask,
      }),
    ).toEqual({
      logProbe: echo,
      logLevelFilteringProbe: { toolName: "loud", level: "error" },
    });
  });

  it("sends nothing without probes", () => {
    expect(protocolProbeFields(undefined)).toEqual({});
  });
});

describe("tasksSdkFields", () => {
  it("passes the Tasks inputs through and leaves out unset ones", () => {
    expect(
      tasksSdkFields({
        toolName: "create_task",
        toolArguments: { n: 1 },
        inputResponses: { answer: "yes" },
      }),
    ).toEqual({
      toolName: "create_task",
      toolArguments: { n: 1 },
      inputResponses: { answer: "yes" },
    });
    expect(tasksSdkFields({})).toEqual({});
  });
});

describe("storedSelection", () => {
  it("reads saved checks and advice as one selection of known ids", () => {
    // Saved ids are plain strings: one renamed or removed since is dropped.
    const saved: string[] = ["tools-list", "a-check-this-build-does-not-know"];
    expect(
      storedSelection({
        defaultChecks: {
          protocol: saved as MCPCheckId[],
          apps: [],
          oauth: false,
        },
        defaultAdvice: {
          tasksAdvice: ["tasks-readiness-failed-status-message"],
        },
      }),
    ).toEqual({
      protocol: ["tools-list"],
      apps: [],
      oauth: false,
      tasksAdvice: ["tasks-readiness-failed-status-message"],
    });
  });

  it("selects every check of every suite for a server with no saved row", () => {
    expect(storedSelection(null)).toEqual({});
  });
});

describe("stored probes", () => {
  it("round-trips tool arguments and answers through their stored JSON text", () => {
    const probes: ConformanceProbes = {
      toolCallProbe: echo,
      tasksProbe: { ...createTask, inputResponses: { answer: "yes" } },
    };
    const stored = encodeStoredProbes(probes);
    expect(stored.toolCallProbe).toEqual({
      toolName: "echo",
      arguments: '{"text":"hi"}',
    });
    expect(decodeStoredProbes(stored)).toEqual(probes);
  });

  it("refuses stored arguments that are not a JSON object", () => {
    expect(
      decodeStoredProbes({
        toolCallProbe: { toolName: "echo", arguments: "[1]" },
      }),
    ).toBeInstanceOf(Error);
  });
});

describe("withoutTaskAnswersCheck", () => {
  it("drops the update check, under its old id too", () => {
    expect(
      withoutTaskAnswersCheck({
        tasks: ["tasks-input-required-update-completes", "tasks-ttl-shape"],
      } as ConformanceSelection).tasks,
    ).toEqual(["tasks-ttl-shape"]);
    expect(withoutTaskAnswersCheck(undefined).tasks).toEqual(
      MCP_TASKS_CHECK_IDS.filter((id) => id !== "tasks-update-ack-shape"),
    );
  });
});

describe("conformanceSuiteConfigs", () => {
  const probes: ConformanceProbes = {
    logProbe: echo,
    inputRequiredProbe: echo,
    toolCallProbe: echo,
    tasksProbe: createTask,
  };

  it("never runs the update check or sends its saved answers", () => {
    const { tasks } = conformanceSuiteConfigs(
      {
        selection: {},
        probes: { tasksProbe: { ...createTask, inputResponses: { ok: 1 } } },
      },
      "2026-07-28",
    );
    expect(tasks.checkIds).not.toContain("tasks-update-ack-shape");
    expect(tasks.inputResponses).toBeUndefined();
  });

  it("sends a tool only for a picked check that runs at the pin", () => {
    const picked: MCPCheckId[] = [
      "tools-list",
      "modern-tool-output-schema-conformant",
    ];
    const { protocol } = conformanceSuiteConfigs(
      { selection: { protocol: picked, protocolAdvice: [] }, probes },
      "2026-07-28",
    );
    expect(protocol).toEqual({
      checkIds: inCatalogOrder(picked),
      readinessIds: [],
      fixtures: { toolCalls: [echo] },
    });
  });

  it("sends the log tool for the log level advice when advice is left at all", () => {
    const { protocol } = conformanceSuiteConfigs(
      { selection: { protocol: ["tools-list"] }, probes },
      "2026-07-28",
    );
    expect(protocol).toEqual({ checkIds: ["tools-list"], logProbe: echo });
  });

  it("drops checks outside a legacy pin's era and calls no tool there", () => {
    const { protocol } = conformanceSuiteConfigs(
      {
        selection: {
          protocol: [
            "server-initialize",
            "tools-list",
            "modern-tool-output-schema-conformant",
          ],
        },
        probes,
      },
      "2025-11-25",
    );
    expect(protocol).toEqual({
      checkIds: inCatalogOrder(["server-initialize", "tools-list"]),
    });
  });

  it("runs every check but the update check, and calls no tool, for a server with no saved settings", () => {
    const configs = conformanceSuiteConfigs({ probes: {} }, "2025-11-25");
    const tasks = MCP_TASKS_CHECK_IDS.filter(
      (id) => id !== "tasks-update-ack-shape",
    );
    expect(configs).toMatchObject({ protocol: {}, apps: {} });
    expect(configs.selection).toEqual({ tasks });
    expect(configs.tasks).toEqual({ checkIds: tasks });
  });

  it("reports a suite the settings leave out", () => {
    const { selection, apps } = conformanceSuiteConfigs(
      { selection: { apps: [], tasks: ["tasks-wire-resolvable"] }, probes },
      "2026-07-28",
    );
    expect(isSelected(selection?.apps)).toBe(false);
    expect(isSelected(selection?.tasks)).toBe(true);
    expect(apps).toEqual({ checkIds: [] });
  });

  it("gives the Tasks suite its tool only when a picked check calls it", () => {
    expect(
      conformanceSuiteConfigs(
        { selection: { tasks: ["tasks-wire-resolvable"] }, probes },
        "2026-07-28",
      ).tasks,
    ).toEqual({ checkIds: ["tasks-wire-resolvable"] });
    expect(
      conformanceSuiteConfigs(
        { selection: { tasks: ["tasks-ttl-shape"] }, probes },
        "2026-07-28",
      ).tasks,
    ).toEqual({
      checkIds: ["tasks-ttl-shape"],
      toolName: "create_task",
      toolArguments: { n: 1 },
    });
  });
});
