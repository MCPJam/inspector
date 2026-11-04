import { useEffect, useMemo, useState } from "react";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  isHttpServer,
  type ConformanceSelection,
  type ProtocolVersionPin,
} from "@/hooks/use-conformance-run";
import {
  probeInputStatus,
  PROBE_KEYS,
  probeKeyFor,
  probesApply,
  tasksProbeRuns,
  type ConformanceProbeKey,
  type ConformanceProbes,
} from "@/hooks/use-conformance-probes";
import { ConformanceCheckPicker } from "./ConformanceCheckPicker";
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
  defaultsMode = false,
}: {
  server?: ServerWithName | null;
  versionPin: ProtocolVersionPin;
  selection: ConformanceSelection;
  onChange: (selection: ConformanceSelection) => void;
  probes: ConformanceProbes;
  onProbesChange: (probes: ConformanceProbes) => void;
  onValidChange: (valid: boolean) => void;
  defaultsMode?: boolean;
}) {
  const [probeValid, setProbeValid] = useState<
    Partial<Record<ConformanceProbeKey | "answers", boolean>>
  >({});
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
            !acceptsToolArguments(tool.inputSchema, probe.arguments ?? {})
          );
        }),
      ),
    [probes, probeTools.tools],
  );
  const inputStatusFor = (checkId: string) => {
    const key = probeKeyFor(checkId);
    return key && (invalidProbeArguments.has(key) || probeValid[key] === false)
      ? "missing"
      : probeInputStatus(checkId, probes);
  };
  const valid = !Object.values(probeValid).includes(false);
  useEffect(() => {
    onValidChange(valid);
  }, [valid, onValidChange]);
  return (
    <ConformanceCheckPicker
      versionPin={versionPin}
      selection={selection}
      onChange={onChange}
      showAdvice
      defaultOpen={defaultsMode}
      renderCheckExtra={
        probeServer
          ? (suite, checkId, isPicked, checkTitle) =>
              (suite === "protocol" && protocolProbes) ||
              (suite === "tasks" && tasksProbe) ? (
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
      checkInputStatus={(suite, checkId) => {
        if (suite === "protocol" && protocolProbes) {
          // The output check needs a tool only when one declares
          // an output schema; otherwise it does not apply.
          const noOutputSchemas =
            probeTools.status === "ready" &&
            !probeTools.truncated &&
            !probeTools.tools.some((tool) => tool.hasOutputSchema);
          return probeKeyFor(checkId) === "toolCallProbe" && noOutputSchemas
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
          if (canPickTaskTool) return undefined;
          return inputStatusFor(checkId);
        }
        return undefined;
      }}
    />
  );
}
