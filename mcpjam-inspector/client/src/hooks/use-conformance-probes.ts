/**
 * The tools an operator names as safe for the protocol suite to call, kept
 * per server.
 *
 * Three 2026-07-28 checks can only observe something on a tool call: the
 * logging check needs a tool that emits logs (the log level filtering advice
 * calls the same tool, at the operator's log level, unless it has its own),
 * the undeclared-capability check needs one that asks for input, and the
 * output-schema check needs one whose result it can grade. The SDK never picks
 * a tool on its own,
 * because nothing a server advertises says whether calling a tool charges a
 * card or deletes a row. Without one, those checks report could-not-run.
 *
 * The Tasks suite uses a default tool plus optional per-check overrides. On a
 * server that uses the Tasks extension no tool says it creates a task, so
 * without one those checks could not run either.
 *
 * Protocol defaults for saved servers live in Convex; their drafts stay in
 * session. Tasks defaults and overrides, and the advice's own log tool, also
 * persist in browser storage.
 */
import { useCallback, useRef, useState } from "react";
import {
  MCP_LOG_LEVELS,
  MCP_TASKS_TOOL_CHECK_IDS,
  isTasksToolCheck,
} from "@mcpjam/sdk/browser";
import {
  PROBE_KEYS,
  type ConformanceProbe,
  type ConformanceProbeKey,
  type ConformanceProbes,
} from "@/shared/conformance-settings";

// Which checks call which tool, and what a run sends, are shared with the
// hosted executor; this module adds the browser's own storage.
export {
  LOG_LEVEL_ADVICE,
  LOGS_CHECK,
  PROBE_CHECKS,
  PROBE_KEYS,
  TASK_ANSWERS_CHECK,
  logLevelOverrideApplies,
  probeInputStatus,
  probeKeyFor,
  probesAfterRun,
  probesApply,
  probesForRun,
  protocolProbesFor,
  protocolRunOptions,
  tasksProbeRuns,
  tasksRunOptions,
} from "@/shared/conformance-settings";
export type { ConformanceProbe, ConformanceProbeKey, ConformanceProbes };

const STORAGE_PREFIX = "mcpjam.conformance.probes.v1:";

function isProbe(
  value: unknown,
  allowEmptyTool = false,
): value is ConformanceProbe {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const probe = value as { toolName?: unknown; arguments?: unknown };
  return (
    typeof probe.toolName === "string" &&
    (allowEmptyTool || probe.toolName.trim() !== "") &&
    (probe.arguments === undefined ||
      (typeof probe.arguments === "object" &&
        probe.arguments !== null &&
        !Array.isArray(probe.arguments)))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A saved probe keeping only the extras its key can send: a valid `level` on
 * the log probe, an object `inputResponses` on the Tasks probe.
 */
function withOwnExtras(
  probe: ConformanceProbe,
  key: ConformanceProbeKey,
): ConformanceProbe {
  const { level, inputResponses, ...rest } = probe;
  return {
    ...rest,
    ...(key === "logProbe" &&
    (MCP_LOG_LEVELS as readonly unknown[]).includes(level)
      ? { level }
      : {}),
    ...(key === "tasksProbe" && isRecord(inputResponses)
      ? { inputResponses }
      : {}),
  };
}

/** What was saved for `serverName`, dropping anything malformed. */
export function readStoredProbes(serverName: string): ConformanceProbes {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + serverName);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const tasksOverrides: NonNullable<ConformanceProbes["tasksOverrides"]> = {};
    if (isRecord(parsed.tasksOverrides))
      for (const [id, value] of Object.entries(parsed.tasksOverrides)) {
        if (isTasksToolCheck(id) && isProbe(value, true))
          tasksOverrides[id] = withOwnExtras(value, "tasksProbe");
      }
    const logLevelOverride = isProbe(parsed.logLevelOverride, true)
      ? withOwnExtras(parsed.logLevelOverride, "logProbe")
      : undefined;
    return {
      ...Object.fromEntries(
        (["tasksProbe"] as const).flatMap((key) => {
          const probe = parsed[key];
          return isProbe(probe) ? [[key, withOwnExtras(probe, key)]] : [];
        }),
      ),
      ...(Object.keys(tasksOverrides).length ? { tasksOverrides } : {}),
      ...(logLevelOverride ? { logLevelOverride } : {}),
    } as ConformanceProbes;
  } catch {
    // Unreadable storage or a corrupt entry: as if nothing was chosen.
    return {};
  }
}

function writeStoredProbes(serverName: string, probes: ConformanceProbes) {
  try {
    const key = STORAGE_PREFIX + serverName;
    if (
      PROBE_KEYS.every((name) => !probes[name]) &&
      !Object.keys(probes.tasksOverrides ?? {}).length &&
      !probes.logLevelOverride
    ) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          tasksProbe: probes.tasksProbe,
          tasksOverrides: probes.tasksOverrides,
          logLevelOverride: probes.logLevelOverride,
        }),
      );
    }
  } catch {
    // Unwritable storage: the choice still applies to this session's runs.
  }
}

/**
 * Every server's probes, for one page: the setup steps, Settings and the run
 * view read and write the same choice, so Run again uses what was just set.
 */
export function useConformanceProbeStore(): {
  probesFor: (serverName: string) => ConformanceProbes;
  setProbes: (serverName: string, probes: ConformanceProbes) => void;
} {
  // Maps, not objects: a server may be named `constructor` or `__proto__`.
  const [changed, setChanged] = useState<
    ReadonlyMap<string, ConformanceProbes>
  >(() => new Map());
  // Read from storage once per server: the tab asks on every render, and a
  // fresh object each time would also look like a change to its readers.
  const loaded = useRef(new Map<string, ConformanceProbes>());
  const probesFor = useCallback(
    (serverName: string) => {
      const set = changed.get(serverName);
      if (set) return set;
      let stored = loaded.current.get(serverName);
      if (!stored) {
        stored = readStoredProbes(serverName);
        loaded.current.set(serverName, stored);
      }
      return stored;
    },
    [changed],
  );
  const setProbes = useCallback(
    (serverName: string, probes: ConformanceProbes) => {
      setChanged((prev) => new Map(prev).set(serverName, probes));
      writeStoredProbes(serverName, probes);
    },
    [],
  );
  return { probesFor, setProbes };
}

/** Only selected inputs can block Run, including a default used by at least one check. */
export function taskProbePartIsSelected(part: string, probes: ConformanceProbes, selected?: readonly string[]): boolean {
  if (part === "tasksProbe") return MCP_TASKS_TOOL_CHECK_IDS.some(id => (!selected || selected.includes(id)) && !probes.tasksOverrides?.[id]);
  const check = part.replace(/:answers$/, "");
  return !isTasksToolCheck(check) || !selected || selected.includes(check);
}
