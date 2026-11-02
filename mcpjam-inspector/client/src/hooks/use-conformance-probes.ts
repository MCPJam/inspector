/**
 * The tools an operator names as safe for the protocol suite to call, kept
 * per server.
 *
 * Three 2026-07-28 checks can only observe something on a tool call: the two
 * logging checks need a tool that emits logs, and the undeclared-capability
 * check needs one that asks for input. The SDK never picks a tool on its own,
 * because nothing a server advertises says whether calling a tool charges a
 * card or deletes a row. Without one, those checks report could-not-run.
 *
 * Kept in browser storage, keyed by server name, so a choice survives a reload
 * and Run again reuses it. Storage can be missing or throw (private windows,
 * blocked site data); the page then behaves as if nothing was chosen, which
 * is the default.
 */
import { useCallback, useRef, useState } from "react";
import {
  CHECK_ERAS,
  PROTOCOL_VERSION_ERAS,
  type MCPCheckId,
} from "@mcpjam/sdk/browser";
import type { ProtocolVersionPin } from "@/hooks/use-conformance-run";
import type {
  ConformanceProbe,
  ConformanceProbes,
} from "@/lib/apis/mcp-conformance-api";

export type { ConformanceProbe, ConformanceProbes };
export type ConformanceProbeKey = keyof ConformanceProbes;

export const PROBE_KEYS = ["logProbe", "inputRequiredProbe"] as const;

/** The checks each probe is called for. */
export const PROBE_CHECKS: Record<ConformanceProbeKey, readonly MCPCheckId[]> =
  {
    logProbe: ["modern-logs-require-log-level", "modern-log-level-filtering"],
    inputRequiredProbe: ["modern-undeclared-capability-error"],
  };

/** The probe a check calls, if it calls one. */
export function probeKeyFor(checkId: string): ConformanceProbeKey | undefined {
  return PROBE_KEYS.find((key) =>
    (PROBE_CHECKS[key] as readonly string[]).includes(checkId),
  );
}

/**
 * Whether a probe's tool is called on a run with this pin: one of its checks
 * runs in the pin's era (and, with `checkIds`, is picked). Never on "auto":
 * an unpinned client does not offer 2026-07-28, so the run stays in the
 * legacy era, where these checks do not apply.
 */
function probeRuns(
  key: ConformanceProbeKey,
  pin: ProtocolVersionPin,
  checkIds?: readonly string[],
): boolean {
  if (pin === "auto") return false;
  const era = PROTOCOL_VERSION_ERAS[pin];
  return PROBE_CHECKS[key].some(
    (id) =>
      (CHECK_ERAS[id] as readonly string[]).includes(era) &&
      (checkIds === undefined || checkIds.includes(id)),
  );
}

/** Whether any probe applies with this pin: the fields show only then. */
export function probesApply(pin: ProtocolVersionPin): boolean {
  return PROBE_KEYS.some((key) => probeRuns(key, pin));
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
 * Only the probes a run's protocol checks call. A tool is called only for a
 * check that runs, so one named for a check left out is not sent at all.
 * `checkIds` absent means every check.
 */
export function probesForRun(
  probes: ConformanceProbes,
  checkIds: readonly string[] | undefined,
  pin: ProtocolVersionPin,
): ConformanceProbes {
  return Object.fromEntries(
    PROBE_KEYS.filter(
      (key) => probes[key] && probeRuns(key, pin, checkIds),
    ).map((key) => [key, probes[key]]),
  ) as ConformanceProbes;
}

/**
 * What a server keeps after a run: the draft's tool for each probe whose
 * checks ran, the saved one for the rest. A tool picked only for checks that
 * were then left out is not saved, so no later run calls it unasked.
 */
export function probesAfterRun(
  saved: ConformanceProbes,
  draft: ConformanceProbes,
  checkIds: readonly string[] | undefined,
  pin: ProtocolVersionPin,
): ConformanceProbes {
  return Object.fromEntries(
    PROBE_KEYS.flatMap((key) => {
      const probe = probeRuns(key, pin, checkIds) ? draft[key] : saved[key];
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

/** What was saved for `serverName`, dropping anything malformed. */
export function readStoredProbes(serverName: string): ConformanceProbes {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + serverName);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(isProbe(parsed.logProbe) ? { logProbe: parsed.logProbe } : {}),
      ...(isProbe(parsed.inputRequiredProbe)
        ? { inputRequiredProbe: parsed.inputRequiredProbe }
        : {}),
    };
  } catch {
    // Unreadable storage or a corrupt entry: as if nothing was chosen.
    return {};
  }
}

function writeStoredProbes(serverName: string, probes: ConformanceProbes) {
  try {
    const key = STORAGE_PREFIX + serverName;
    if (!probes.logProbe && !probes.inputRequiredProbe) {
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
