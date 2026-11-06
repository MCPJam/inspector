import { isTasksToolCheck } from "@mcpjam/sdk/browser";
import { TasksSuiteDefaults, TasksCheckOverride } from "./TasksCheckOverride";
import { useEffect, useMemo, useState } from "react";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  isHttpServer,
  type ConformanceSelection,
  type ProtocolVersionPin,
} from "@/hooks/use-conformance-run";
import {
  LOG_LEVEL_ADVICE,
  probeInputStatus,
  PROBE_KEYS,
  probeKeyFor,
  probesApply,
  protocolProbesFor,
  tasksProbeRuns,
  taskProbePartIsSelected,
  type ConformanceProbes,
} from "@/hooks/use-conformance-probes";
import {
  ConformanceCheckPicker,
  withoutMissingInputs,
  type CheckSuite,
} from "./ConformanceCheckPicker";
import { ProbeCheckExtra, useProbeTools } from "./ConformanceProbeField";
import { acceptsToolArguments } from "./conformance-tool-input";

/** One editor for setup drafts and server defaults. */
export function ConformanceChecksEditor({
  server,
  versionPin,
  selection,
  onChange,
  probes,
  onProbesChange,
  onValidChange,
  onRunSelectionChange,
  defaultsMode = false,
}: {
  server?: ServerWithName | null;
  versionPin: ProtocolVersionPin;
  selection: ConformanceSelection;
  onChange: (selection: ConformanceSelection) => void;
  probes: ConformanceProbes;
  onProbesChange: (probes: ConformanceProbes) => void;
  onValidChange: (valid: boolean) => void;
  /** What a run sends: `selection` without the checks missing their input. */
  onRunSelectionChange?: (selection: ConformanceSelection) => void;
  defaultsMode?: boolean;
}) {
  const [probeValid, setProbeValid] = useState<Record<string, boolean>>({});
  const protocolProbes = Boolean(
    server && isHttpServer(server) && (defaultsMode || probesApply(versionPin)),
  );
  const tasksProbe = tasksProbeRuns(selection.tasks);
  const probeServer = server && (protocolProbes || tasksProbe) ? server : null;
  const probeTools = useProbeTools(probeServer);
  const invalidProbeArguments = useMemo(
    () =>
      new Set(
        PROBE_KEYS.filter((key) => {
          const probe = probes[key];
          if (!probe) return false;
          const tool = probeTools.tools.find(
            (item) => item.name === probe.toolName,
          );
          return (
            tool?.inputSchema !== undefined &&
            acceptsToolArguments(tool.inputSchema, probe.arguments ?? {}) ===
              false
          );
        }),
      ),
    [probes, probeTools.tools],
  );
  // The advice's own log tool counts only while the logging check is picked.
  const usedProbes = protocolProbesFor(probes, selection.protocol);
  const overrideFor = (checkId: string) =>
    isTasksToolCheck(checkId)
      ? usedProbes.tasksOverrides?.[checkId]
      : checkId === LOG_LEVEL_ADVICE
        ? usedProbes.logLevelOverride
        : undefined;
  const inputStatusFor = (checkId: string) => {
    const override = overrideFor(checkId);
    if (override) {
      const tool = probeTools.tools.find(
        (item) => item.name === override.toolName,
      );
      return probeValid[checkId] === false ||
        (tool?.inputSchema !== undefined &&
          acceptsToolArguments(tool.inputSchema, override.arguments ?? {}) ===
            false)
        ? "missing"
        : probeInputStatus(checkId, usedProbes);
    }
    const key = probeKeyFor(checkId);
    // A row's own field can hold an unparsed draft while it still inherits.
    return key &&
      (invalidProbeArguments.has(key) ||
        probeValid[key] === false ||
        probeValid[checkId] === false)
      ? "missing"
      : probeInputStatus(checkId, usedProbes);
  };
  // With no output schema declared, the output check has nothing to grade, so
  // it does not apply. A cut-off list cannot show that: a later tool may
  // declare one.
  const noOutputSchemas =
    probeTools.status === "ready" &&
    !probeTools.truncated &&
    !probeTools.tools.some((tool) => tool.hasOutputSchema);
  // A saved output tool still gets called, so its field stays shown until the
  // user clears it.
  const outputCheckNotApplicable = (suite: string, checkId: string) =>
    suite === "protocol" &&
    protocolProbes &&
    noOutputSchemas &&
    !probes.toolCallProbe &&
    probeKeyFor(checkId) === "toolCallProbe";
  const valid = !Object.entries(probeValid).some(
    ([part, valid]) =>
      !valid && taskProbePartIsSelected(part, probes, selection.tasks),
  );
  useEffect(() => {
    onValidChange(valid);
  }, [valid, onValidChange]);
  const inputStatus = (suite: CheckSuite, checkId: string) => {
    if (suite === "protocol" && protocolProbes) {
      return outputCheckNotApplicable(suite, checkId)
        ? undefined
        : inputStatusFor(checkId);
    }
    if (suite === "tasks" && tasksProbe) {
      // Metadata belongs to the existing connection, so a 2026 pin still
      // requires an explicit tool even when a legacy task tool is listed.
      const canPickTaskTool =
        versionPin !== "2026-07-28" &&
        !probes.tasksProbe &&
        probeTools.canAutoPickTaskTool;
      if (
        canPickTaskTool &&
        !(isTasksToolCheck(checkId) && probes.tasksOverrides?.[checkId])
      )
        return undefined;
      return inputStatusFor(checkId);
    }
    return undefined;
  };
  // A run leaves out the checks still missing their input. Reported by its
  // JSON, so an equal selection rebuilt on each render is not sent again.
  const runSelection = withoutMissingInputs(selection, versionPin, inputStatus);
  const runSelectionKey = JSON.stringify(runSelection);
  useEffect(() => {
    onRunSelectionChange?.(JSON.parse(runSelectionKey));
  }, [runSelectionKey, onRunSelectionChange]);
  return (
    <ConformanceCheckPicker
      versionPin={versionPin}
      selection={selection}
      onChange={onChange}
      showAdvice
      defaultOpen={defaultsMode}
      renderSuiteExtra={(suite) =>
        suite === "tasks" && probeServer && tasksProbe ? (
          <TasksSuiteDefaults
            tools={probeTools}
            probes={probes}
            onChange={onProbesChange}
            selected={selection.tasks}
            onValidChange={(valid) =>
              setProbeValid((prev) => ({ ...prev, tasksProbe: valid }))
            }
          />
        ) : null
      }
      renderCheckExtra={
        probeServer
          ? (suite, checkId, isPicked, checkTitle) =>
              suite === "tasks" && tasksProbe ? (
                <TasksCheckOverride
                  checkId={checkId}
                  checkTitle={checkTitle(checkId)}
                  picked={isPicked(checkId)}
                  tools={probeTools}
                  probes={probes}
                  onChange={onProbesChange}
                  onValidChange={(part, valid) =>
                    setProbeValid((prev) => ({ ...prev, [part]: valid }))
                  }
                />
              ) : suite === "protocol" &&
                protocolProbes &&
                !outputCheckNotApplicable(suite, checkId) ? (
                <ProbeCheckExtra
                  checkId={checkId}
                  checkTitle={checkTitle}
                  isPicked={isPicked}
                  tools={probeTools}
                  probes={probes}
                  onProbesChange={onProbesChange}
                  onValidChange={(part, valid) =>
                    setProbeValid((prev) => ({
                      ...prev,
                      [part]: valid,
                    }))
                  }
                />
              ) : null
          : undefined
      }
      checkInputStatus={inputStatus}
      checkNotApplicable={(suite, checkId) =>
        outputCheckNotApplicable(suite, checkId)
          ? "No tool on this server declares an output schema, so this check does not apply."
          : undefined
      }
    />
  );
}