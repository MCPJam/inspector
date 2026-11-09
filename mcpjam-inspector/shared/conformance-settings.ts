/**
 * What a conformance run executes for a saved server: the checks its saved
 * settings pick, the tools those checks may call, and the SDK config each
 * suite gets.
 *
 * The app and the hosted executor both build a run from a server's saved
 * settings through this module, so the same settings select the same checks
 * and send the same tool inputs from either place. Browser-safe: values come
 * from the SDK's browser entry, and the SDK config types are erased at build.
 */
import type {
  MCPConformanceConfig,
  MCPTasksConformanceConfig,
} from "@mcpjam/sdk";
import {
  CHECK_ERAS,
  MCP_APPS_CHECK_IDS,
  MCP_CHECK_IDS,
  MCP_OAUTH_READINESS_IDS,
  MCP_READINESS_IDS,
  MCP_TASKS_CHECK_IDS,
  MCP_TASKS_READINESS_IDS,
  MCP_TASKS_TOOL_CHECK_IDS,
  PROTOCOL_VERSION_ERAS,
  READINESS_ERAS,
  RENAMED_MCP_TASKS_CHECK_IDS,
  isTasksToolCheck,
  type MCPAppsCheckId,
  type MCPCheckId,
  type MCPLogLevel,
  type MCPOAuthReadinessId,
  type MCPReadinessId,
  type MCPTasksCheckId,
  type MCPTasksCheckOverrides,
  type MCPTasksReadinessId,
  type MCPTasksToolCheckId,
  type McpProtocolVersion,
} from "@mcpjam/sdk/browser";

/** "auto" ⇒ no pin: the run adopts whatever version the server negotiates. */
export type ProtocolVersionPin = "auto" | McpProtocolVersion;

/** A tool named as safe for a protocol check to call, with its arguments. */
export interface ConformanceProbe {
  toolName: string;
  arguments?: Record<string, unknown>;
  /**
   * `logProbe` and `logLevelOverride` only: the log level the log level
   * filtering advice asks for. Absent means the SDK's default, `warning`.
   */
  level?: MCPLogLevel;
  /**
   * `tasksProbe` only: the answers `tasks/update` sends when the task asks
   * for input, keyed by `inputRequests` key. Absent means the update
   * acknowledgement check is not applicable.
   */
  inputResponses?: Record<string, unknown>;
}

/**
 * The tools the checks that must call one may use: `logProbe` for the logging
 * check and the log level filtering advice, `inputRequiredProbe` for the
 * undeclared-capability check, `toolCallProbe` for the output-schema check,
 * `tasksProbe` for the Tasks checks that need a created task.
 */
export interface ConformanceProbes {
  logProbe?: ConformanceProbe;
  inputRequiredProbe?: ConformanceProbe;
  toolCallProbe?: ConformanceProbe;
  tasksProbe?: ConformanceProbe;
  tasksOverrides?: Partial<Record<MCPTasksToolCheckId, ConformanceProbe>>;
  /**
   * The log level filtering advice's own tool, used instead of `logProbe`.
   * Absent means the advice uses `logProbe`. Kept on this browser, like
   * `tasksOverrides`.
   */
  logLevelOverride?: ConformanceProbe;
}

/**
 * The checks a run covers. A missing list runs the whole suite, so a check
 * added later still runs; an empty one, or `oauth: false`, leaves the suite
 * out. OAuth runs as one flow, so it RUNS all or nothing; `oauthUnscored`
 * names steps that still run but do not count toward the score.
 */
export interface ConformanceSelection {
  protocol?: MCPCheckId[];
  /**
   * The protocol suite's advice, which costs no points. Missing runs all of
   * it; empty runs none. It runs only with the protocol suite, so only when
   * at least one protocol check is picked.
   */
  protocolAdvice?: MCPReadinessId[];
  apps?: MCPAppsCheckId[];
  tasks?: MCPTasksCheckId[];
  /** The Tasks suite's advice, read like `protocolAdvice`. */
  tasksAdvice?: MCPTasksReadinessId[];
  oauth?: boolean;
  /** The OAuth suite's advice, read like `protocolAdvice`. */
  oauthAdvice?: MCPOAuthReadinessId[];
  /** OAuth steps that run with the flow but are left out of the score. */
  oauthUnscored?: string[];
}

export const isSelected = (checkIds: readonly string[] | undefined) =>
  checkIds === undefined || checkIds.length > 0;

function knownIds<T extends string>(
  picked: readonly string[] | undefined,
  known: readonly T[],
): T[] | undefined {
  return picked === undefined
    ? undefined
    : known.filter((id) => picked.includes(id));
}

/**
 * The selection with each suite list cut to ids this build knows: saved
 * defaults are plain strings, so an id renamed or removed since would get the
 * whole suite refused. A pinned version also drops protocol checks outside
 * its era, which would only run as skips.
 */
export function runnableSelection(
  selection: ConformanceSelection | undefined,
  versionPin: ProtocolVersionPin,
): ConformanceSelection | undefined {
  if (!selection) return undefined;
  const pinnedEra =
    versionPin === "auto" ? undefined : PROTOCOL_VERSION_ERAS[versionPin];
  const protocolIds = MCP_CHECK_IDS.filter(
    (id) =>
      pinnedEra === undefined ||
      (CHECK_ERAS[id] as readonly string[]).includes(pinnedEra),
  );
  const adviceIds = MCP_READINESS_IDS.filter(
    (id) =>
      pinnedEra === undefined ||
      (READINESS_ERAS[id] as readonly string[]).includes(pinnedEra),
  );
  return {
    ...selection,
    protocol: knownIds(selection.protocol, protocolIds),
    protocolAdvice: knownIds(selection.protocolAdvice, adviceIds),
    apps: knownIds(selection.apps, MCP_APPS_CHECK_IDS),
    tasks: knownIds(
      selection.tasks?.map((id) =>
        Object.hasOwn(RENAMED_MCP_TASKS_CHECK_IDS, id)
          ? RENAMED_MCP_TASKS_CHECK_IDS[
              id as keyof typeof RENAMED_MCP_TASKS_CHECK_IDS
            ]
          : id,
      ),
      MCP_TASKS_CHECK_IDS,
    ),
    tasksAdvice: knownIds(selection.tasksAdvice, MCP_TASKS_READINESS_IDS),
    oauthAdvice: knownIds(selection.oauthAdvice, MCP_OAUTH_READINESS_IDS),
  };
}

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
  return (
    protocolCheckIds === undefined || protocolCheckIds.includes(LOGS_CHECK)
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The saved checks and advice of one server, as the backend returns them. */
export interface StoredConformanceSettings {
  defaultChecks?: ConformanceSelection;
  defaultAdvice?: Pick<
    ConformanceSelection,
    "protocolAdvice" | "tasksAdvice" | "oauthAdvice"
  >;
}

/**
 * A server's saved checks and advice as a selection this build can run. No
 * saved row selects every check of every suite.
 */
export function storedSelection(
  row: StoredConformanceSettings | null | undefined,
): ConformanceSelection {
  return (
    runnableSelection(
      { ...row?.defaultChecks, ...row?.defaultAdvice },
      "auto",
    ) ?? {}
  );
}

/**
 * The protocol probes as both conformance routes accept them. The advice's
 * own log tool travels as `logLevelFilteringProbe`.
 */
export function protocolProbeFields(probes: ConformanceProbes | undefined) {
  return {
    ...(probes?.logProbe ? { logProbe: probes.logProbe } : {}),
    ...(probes?.logLevelOverride
      ? { logLevelFilteringProbe: probes.logLevelOverride }
      : {}),
    ...(probes?.inputRequiredProbe
      ? { inputRequiredProbe: probes.inputRequiredProbe }
      : {}),
    ...(probes?.toolCallProbe ? { toolCallProbe: probes.toolCallProbe } : {}),
  };
}

/** The protocol suite's checks, advice and probes, as a run request carries them. */
export type ProtocolSuiteRequest = Pick<
  MCPConformanceConfig,
  | "checkIds"
  | "readinessIds"
  | "logProbe"
  | "logLevelFilteringProbe"
  | "inputRequiredProbe"
> & { toolCallProbe?: MCPConformanceConfig["inputRequiredProbe"] };

/**
 * The protocol suite's SDK config for a run request. The output-schema check's
 * tool is a fixture to the SDK, so `toolCallProbe` becomes `fixtures.toolCalls`.
 */
export function protocolSdkFields(
  request: ProtocolSuiteRequest,
): Pick<
  MCPConformanceConfig,
  | "checkIds"
  | "readinessIds"
  | "logProbe"
  | "logLevelFilteringProbe"
  | "inputRequiredProbe"
  | "fixtures"
> {
  return {
    ...(request.checkIds ? { checkIds: request.checkIds } : {}),
    ...(request.readinessIds ? { readinessIds: request.readinessIds } : {}),
    ...(request.logProbe ? { logProbe: request.logProbe } : {}),
    ...(request.logLevelFilteringProbe
      ? { logLevelFilteringProbe: request.logLevelFilteringProbe }
      : {}),
    ...(request.inputRequiredProbe
      ? { inputRequiredProbe: request.inputRequiredProbe }
      : {}),
    ...(request.toolCallProbe
      ? { fixtures: { toolCalls: [request.toolCallProbe] } }
      : {}),
  };
}

/** The Tasks suite's checks, advice and tool inputs, as a run request carries them. */
export type TasksSuiteRequest = Pick<
  MCPTasksConformanceConfig,
  | "checkIds"
  | "readinessIds"
  | "checkOverrides"
  | "toolName"
  | "toolArguments"
  | "inputResponses"
>;

/** The Tasks suite's SDK config for a run request, without the unset fields. */
export function tasksSdkFields(request: TasksSuiteRequest): TasksSuiteRequest {
  return {
    ...(request.checkIds ? { checkIds: request.checkIds } : {}),
    ...(request.readinessIds ? { readinessIds: request.readinessIds } : {}),
    ...(request.checkOverrides
      ? { checkOverrides: request.checkOverrides }
      : {}),
    ...(request.toolName ? { toolName: request.toolName } : {}),
    ...(request.toolArguments ? { toolArguments: request.toolArguments } : {}),
    ...(request.inputResponses
      ? { inputResponses: request.inputResponses }
      : {}),
  };
}

/**
 * Each suite's SDK config for a run of these settings at this pin, built the
 * way the app builds its suite requests. `selection` is what runs: a suite it
 * leaves out (an empty list, or `oauth: false`) is not part of the run.
 */
export function conformanceSuiteConfigs(
  settings: { selection?: ConformanceSelection; probes: ConformanceProbes },
  pin: ProtocolVersionPin,
) {
  const selection = runnableSelection(settings.selection, pin);
  const { checkIds, readinessIds, probes } = protocolRunOptions(
    settings.probes,
    selection,
    pin,
  );
  return {
    selection,
    protocol: protocolSdkFields({
      checkIds,
      readinessIds,
      ...protocolProbeFields(probes),
    }),
    apps: selection?.apps ? { checkIds: selection.apps } : {},
    tasks: tasksSdkFields(tasksRunOptions(settings.probes, selection)),
  };
}

export type StoredConformanceProbe = Omit<
  ConformanceProbe,
  "arguments" | "inputResponses"
> & {
  arguments?: string;
  inputResponses?: string;
};
export type StoredConformanceProbes = Partial<
  Record<keyof ConformanceProbes, StoredConformanceProbe>
>;

// JSON strings preserve tool-defined keys that Convex object fields cannot hold.
export function encodeStoredProbes(
  inputs: ConformanceProbes,
): StoredConformanceProbes {
  const stored: StoredConformanceProbes = {};
  for (const key of PROBE_KEYS) {
    const probe = inputs[key];
    if (!probe) continue;
    const { arguments: args, inputResponses, ...fields } = probe;
    stored[key] = {
      ...fields,
      ...(args !== undefined ? { arguments: JSON.stringify(args) } : {}),
      ...(inputResponses !== undefined
        ? { inputResponses: JSON.stringify(inputResponses) }
        : {}),
    };
  }
  return stored;
}
export function decodeStoredProbes(
  stored: StoredConformanceProbes = {},
): ConformanceProbes | Error {
  const inputs: ConformanceProbes = {};
  const parseObject = (text: string): Record<string, unknown> => {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error();
    return value;
  };
  try {
    for (const key of PROBE_KEYS) {
      const probe = stored[key];
      if (!probe) continue;
      const { arguments: args, inputResponses, ...fields } = probe;
      inputs[key] = {
        ...fields,
        ...(args !== undefined ? { arguments: parseObject(args) } : {}),
        ...(inputResponses !== undefined
          ? { inputResponses: parseObject(inputResponses) }
          : {}),
      };
    }
    return inputs;
  } catch {
    // Report a failed read without exposing input contents or using partial inputs.
    return new Error("Could not load your saved inputs. Try again.");
  }
}
