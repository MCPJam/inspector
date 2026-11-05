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
  CHECK_ERAS,
  MCP_READINESS_IDS,
  MCP_TASKS_TOOL_CHECK_IDS,
  isTasksToolCheck,
  type MCPTasksCheckOverrides,
  MCP_LOG_LEVELS,
  PROTOCOL_VERSION_ERAS,
  READINESS_ERAS,
  type MCPCheckId,
  type MCPReadinessId,
  type MCPTasksCheckId,
} from "@mcpjam/sdk/browser";
import type {
  ConformanceSelection,
  ProtocolVersionPin,
} from "@/hooks/use-conformance-run";
import type {
  ConformanceProbe,
  ConformanceProbes,
} from "@/lib/apis/mcp-conformance-api";

export type { ConformanceProbe, ConformanceProbes };
export type ConformanceProbeKey = Exclude<
  keyof ConformanceProbes,
  "tasksOverrides" | "logLevelOverride"
>;

export const PROBE_KEYS = [
  "logProbe",
  "inputRequiredProbe",
  "toolCallProbe",
  "tasksProbe",
] as const;

type ProtocolProbeKey = Exclude<ConformanceProbeKey, "tasksProbe">;

const PROTOCOL_PROBE_CHECKS: Record<
  ProtocolProbeKey,
  readonly (MCPCheckId | MCPReadinessId)[]
> = {
  logProbe: ["modern-logs-require-log-level", "readiness-log-level-filtering"],
  inputRequiredProbe: ["modern-undeclared-capability-error"],
  toolCallProbe: ["modern-tool-output-schema-conformant"],
};

/**
 * The Tasks checks that inspect the task the tool creates (or, for the two
 * creation checks, the call itself). The others never call it, and the Tasks
 * advice only reads what these checks already saw.
 */
const TASKS_PROBE_CHECKS = MCP_TASKS_TOOL_CHECK_IDS;

/**
 * The checks, and advice, each probe is called for. The first one picked shows
 * the tool field; the others point to it.
 */
export const PROBE_CHECKS: Record<ConformanceProbeKey, readonly string[]> = {
  ...PROTOCOL_PROBE_CHECKS,
  tasksProbe: TASKS_PROBE_CHECKS,
};

function isProtocolProbe(key: ConformanceProbeKey): key is ProtocolProbeKey {
  return key !== "tasksProbe";
}

/** The check that sends the Tasks answers, so its row shows the answers box. */
export const TASK_ANSWERS_CHECK =
  "tasks-update-ack-shape" satisfies MCPTasksCheckId;

/** The advice that asks for a log level, so its row shows the level field. */
export const LOG_LEVEL_ADVICE: MCPReadinessId = "readiness-log-level-filtering";

/** The logging check whose tool the log level filtering advice inherits. */
export const LOGS_CHECK: MCPCheckId = "modern-logs-require-log-level";

function isAdvice(id: string): id is MCPReadinessId {
  return Object.hasOwn(READINESS_ERAS, id);
}

function erasOf(id: MCPCheckId | MCPReadinessId): readonly string[] {
  return isAdvice(id) ? READINESS_ERAS[id] : CHECK_ERAS[id];
}

/**
 * Whether the advice's own log tool counts: only while the logging check is
 * picked too. Alone, the advice row sets the shared log tool itself, so that
 * is the one it calls. `protocolCheckIds` absent means every check.
 */
export function logLevelOverrideApplies(
  protocolCheckIds?: readonly string[],
): boolean {
  return protocolCheckIds === undefined || protocolCheckIds.includes(LOGS_CHECK);
}

/** The probes as the picked protocol checks use them. */
export function protocolProbesFor(
  probes: ConformanceProbes,
  protocolCheckIds?: readonly string[],
): ConformanceProbes {
  if (!probes.logLevelOverride || logLevelOverrideApplies(protocolCheckIds))
    return probes;
  const { logLevelOverride: _unused, ...rest } = probes;
  return rest;
}

/** The probe a check calls, if it calls one. */
export function probeKeyFor(checkId: string): ConformanceProbeKey | undefined {
  return PROBE_KEYS.find((key) =>
    (PROBE_CHECKS[key] as readonly string[]).includes(checkId),
  );
}

/**
 * Whether a protocol probe's tool is called on a run with this pin: one of
 * its checks or advice runs in the pin's era (and, with `checkIds` /
 * `readinessIds`, is picked). Never on "auto": an unpinned client does not
 * offer 2026-07-28, so the run stays in the legacy era, where these checks do
 * not apply.
 */
function probeRuns(
  key: ProtocolProbeKey,
  pin: ProtocolVersionPin,
  checkIds?: readonly string[],
  readinessIds?: readonly string[],
): boolean {
  return PROTOCOL_PROBE_CHECKS[key].some((id) =>
    runsWithPin(id, pin, checkIds, readinessIds),
  );
}

/** Whether one protocol check or advice runs with this pin and these picks. */
function runsWithPin(
  id: MCPCheckId | MCPReadinessId,
  pin: ProtocolVersionPin,
  checkIds?: readonly string[],
  readinessIds?: readonly string[],
): boolean {
  if (pin === "auto") return false;
  const picked = isAdvice(id) ? readinessIds : checkIds;
  return (
    erasOf(id).includes(PROTOCOL_VERSION_ERAS[pin]) &&
    (picked === undefined || picked.includes(id))
  );
}

/**
 * Whether a Tasks run with these picks (absent means all) calls the Tasks
 * probe. The Tasks suite runs its own client on every pin, so the picks alone
 * decide.
 */
export function tasksProbeRuns(checkIds?: readonly string[]): boolean {
  return TASKS_PROBE_CHECKS.some(
    (id) => checkIds === undefined || checkIds.includes(id),
  );
}

/**
 * Whether any protocol probe applies with this pin: the protocol fields show
 * only then.
 */
export function probesApply(pin: ProtocolVersionPin): boolean {
  return PROBE_KEYS.some((key) => isProtocolProbe(key) && probeRuns(key, pin));
}

/**
 * Whether a check that calls a tool has one: "missing" or "set". Nothing for
 * a check that calls none.
 */
export function probeInputStatus(
  checkId: string,
  probes: ConformanceProbes,
): "missing" | "set" | undefined {
  const key = probeKeyFor(checkId);
  if (!key) return undefined;
  const probe = isTasksToolCheck(checkId)
    ? (probes.tasksOverrides?.[checkId] ?? probes.tasksProbe)
    : checkId === LOG_LEVEL_ADVICE
      ? (probes.logLevelOverride ?? probes.logProbe)
      : probes[key];
  return probe?.toolName ? "set" : "missing";
}

/**
 * Only the probes a run's protocol checks and advice call. A tool is called
 * only for one that runs, so one named for checks left out is not sent at
 * all. `checkIds` / `readinessIds` absent means every check / every advice.
 */
export function probesForRun(
  probes: ConformanceProbes,
  checkIds: readonly string[] | undefined,
  pin: ProtocolVersionPin,
  readinessIds?: readonly string[],
): ConformanceProbes {
  const sent = Object.fromEntries(
    PROBE_KEYS.filter(
      (key) =>
        isProtocolProbe(key) &&
        probes[key] &&
        probeRuns(key, pin, checkIds, readinessIds),
    ).map((key) => [key, probes[key]]),
  ) as ConformanceProbes;
  const override = protocolProbesFor(probes, checkIds).logLevelOverride;
  if (
    override?.toolName.trim() &&
    runsWithPin(LOG_LEVEL_ADVICE, pin, checkIds, readinessIds)
  )
    sent.logLevelOverride = override;
  return sent;
}

/**
 * What a protocol run sends for the picked checks and advice: those lists,
 * and only the tools they call, so a tool named for one left out is never
 * executed.
 */
export function protocolRunOptions(
  probes: ConformanceProbes,
  picked: ConformanceSelection | undefined,
  pin: ProtocolVersionPin,
) {
  const checkIds = picked?.protocol;
  // An unfinished choice of the advice's own tool must not fall back to the
  // shared one, so the advice sits this run out.
  const override = protocolProbesFor(probes, checkIds).logLevelOverride;
  const readinessIds =
    override && !override.toolName.trim()
      ? (picked?.protocolAdvice ?? MCP_READINESS_IDS).filter(
          (id) => id !== LOG_LEVEL_ADVICE,
        )
      : picked?.protocolAdvice;
  const sent = probesForRun(probes, checkIds, pin, readinessIds);
  return {
    protocolVersion: pin === "auto" ? undefined : pin,
    ...(checkIds ? { checkIds } : {}),
    ...(readinessIds ? { readinessIds } : {}),
    ...(Object.keys(sent).length > 0 ? { probes: sent } : {}),
  };
}

/**
 * What a Tasks run sends for the picked checks and advice: those lists, the
 * tool that creates the task (and its arguments) only when a picked check
 * calls it, and the input answers only when the update acknowledgement check
 * runs: the SDK submits them through `tasks/update` for any task that asks.
 */
export function tasksRunOptions(
  probes: ConformanceProbes,
  picked: ConformanceSelection | undefined,
) {
  const checkIds = picked?.tasks;
  const readinessIds = picked?.tasksAdvice;
  const probe = tasksProbeRuns(checkIds) ? probes.tasksProbe : undefined;
  const checkOverrides: MCPTasksCheckOverrides = {};
  for (const id of MCP_TASKS_TOOL_CHECK_IDS) {
    const override = probes.tasksOverrides?.[id];
    if (override && (!checkIds || checkIds.includes(id)))
      checkOverrides[id] = {
        toolName: override.toolName,
        ...(override.arguments ? { toolArguments: override.arguments } : {}),
      };
  }
  const update = probes.tasksOverrides?.[TASK_ANSWERS_CHECK] ?? probe;
  const sendsAnswers =
    checkIds === undefined || checkIds.includes(TASK_ANSWERS_CHECK);
  return {
    ...(checkIds ? { checkIds } : {}),
    ...(readinessIds ? { readinessIds } : {}),
    ...(probe
      ? {
          toolName: probe.toolName,
          ...(probe.arguments ? { toolArguments: probe.arguments } : {}),
        }
      : {}),
    ...(Object.keys(checkOverrides).length ? { checkOverrides } : {}),
    ...(sendsAnswers && update?.inputResponses
      ? { inputResponses: update.inputResponses }
      : {}),
  };
}

/**
 * Keep the default for each probe whose checks ran and preserve every Tasks
 * override and the advice's own log tool. Execution filters unselected
 * overrides without deleting settings.
 * `picked` holds each suite's picks; a list absent means all of it.
 */
export function probesAfterRun(
  saved: ConformanceProbes,
  draft: ConformanceProbes,
  picked: ConformanceSelection | undefined,
  pin: ProtocolVersionPin,
): ConformanceProbes {
  return {
    ...Object.fromEntries(
      PROBE_KEYS.flatMap((key) => {
        const ran = isProtocolProbe(key)
          ? probeRuns(key, pin, picked?.protocol, picked?.protocolAdvice)
          : tasksProbeRuns(picked?.tasks);
        const probe = ran ? draft[key] : saved[key];
        return probe ? [[key, probe]] : [];
      }),
    ),
    ...(draft.tasksOverrides ? { tasksOverrides: draft.tasksOverrides } : {}),
    ...(draft.logLevelOverride
      ? { logLevelOverride: draft.logLevelOverride }
      : {}),
  } as ConformanceProbes;
}

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
