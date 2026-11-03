/**
 * The tools an operator names as safe for the protocol suite to call, kept
 * per server.
 *
 * Three 2026-07-28 checks can only observe something on a tool call: the
 * logging check needs a tool that emits logs (the log level filtering advice
 * calls the same tool, at the operator's log level, and has its own row), the
 * undeclared-capability check needs one that asks for input, and the
 * output-schema check needs one whose result it can grade. The SDK never picks
 * a tool on its own,
 * because nothing a server advertises says whether calling a tool charges a
 * card or deletes a row. Without one, those checks report could-not-run.
 *
 * The Tasks suite calls one tool to create the task its checks inspect. On a
 * server that uses the Tasks extension no tool says it creates a task, so
 * without one those checks could not run either.
 *
 * Kept in browser storage, keyed by server name, so a choice survives a reload
 * and Run again reuses it. Storage can be missing or throw (private windows,
 * blocked site data); the page then behaves as if nothing was chosen, which
 * is the default.
 */
import { useCallback, useRef, useState } from "react";
import {
  CHECK_ERAS,
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
export type ConformanceProbeKey = keyof ConformanceProbes;

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
const TASKS_PROBE_CHECKS: readonly MCPTasksCheckId[] = [
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
export const TASK_ANSWERS_CHECK: MCPTasksCheckId = "tasks-update-ack-shape";

/** The advice that asks for a log level, so its row shows the level field. */
export const LOG_LEVEL_ADVICE: MCPReadinessId = "readiness-log-level-filtering";

function isAdvice(id: string): id is MCPReadinessId {
  return Object.hasOwn(READINESS_ERAS, id);
}

function erasOf(id: MCPCheckId | MCPReadinessId): readonly string[] {
  return isAdvice(id) ? READINESS_ERAS[id] : CHECK_ERAS[id];
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
  if (pin === "auto") return false;
  const era = PROTOCOL_VERSION_ERAS[pin];
  return PROTOCOL_PROBE_CHECKS[key].some((id) => {
    const picked = isAdvice(id) ? readinessIds : checkIds;
    return (
      erasOf(id).includes(era) && (picked === undefined || picked.includes(id))
    );
  });
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
  return probes[key] ? "set" : "missing";
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
  return Object.fromEntries(
    PROBE_KEYS.filter(
      (key) =>
        isProtocolProbe(key) &&
        probes[key] &&
        probeRuns(key, pin, checkIds, readinessIds),
    ).map((key) => [key, probes[key]]),
  ) as ConformanceProbes;
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
  const readinessIds = picked?.protocolAdvice;
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
  const sendsAnswers =
    checkIds === undefined || checkIds.includes(TASK_ANSWERS_CHECK);
  return {
    ...(checkIds ? { checkIds } : {}),
    ...(readinessIds ? { readinessIds } : {}),
    ...(probe
      ? {
          toolName: probe.toolName,
          ...(probe.arguments ? { toolArguments: probe.arguments } : {}),
          ...(probe.inputResponses && sendsAnswers
            ? { inputResponses: probe.inputResponses }
            : {}),
        }
      : {}),
  };
}

/**
 * What a server keeps after a run: the draft's tool for each probe whose
 * checks ran, the saved one for the rest. A tool picked only for checks that
 * were then left out is not saved, so no later run calls it unasked.
 * `picked` holds each suite's picks; a list absent means all of it.
 */
export function probesAfterRun(
  saved: ConformanceProbes,
  draft: ConformanceProbes,
  picked: ConformanceSelection | undefined,
  pin: ProtocolVersionPin,
): ConformanceProbes {
  return Object.fromEntries(
    PROBE_KEYS.flatMap((key) => {
      const ran = isProtocolProbe(key)
        ? probeRuns(key, pin, picked?.protocol, picked?.protocolAdvice)
        : tasksProbeRuns(picked?.tasks);
      const probe = ran ? draft[key] : saved[key];
      return probe ? [[key, probe]] : [];
    }),
  ) as ConformanceProbes;
}

const STORAGE_PREFIX = "mcpjam.conformance.probes.v1:";

function isProbe(value: unknown): value is ConformanceProbe {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const probe = value as { toolName?: unknown; arguments?: unknown };
  return (
    typeof probe.toolName === "string" &&
    probe.toolName.trim() !== "" &&
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
    return Object.fromEntries(
      PROBE_KEYS.flatMap((key) => {
        const probe = parsed[key];
        return isProbe(probe) ? [[key, withOwnExtras(probe, key)]] : [];
      }),
    ) as ConformanceProbes;
  } catch {
    // Unreadable storage or a corrupt entry: as if nothing was chosen.
    return {};
  }
}

function writeStoredProbes(serverName: string, probes: ConformanceProbes) {
  try {
    const key = STORAGE_PREFIX + serverName;
    if (PROBE_KEYS.every((name) => !probes[name])) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(probes));
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
