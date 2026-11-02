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
import { useCallback, useState } from "react";
import type { MCPCheckId } from "@mcpjam/sdk/browser";
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
 * Only the probes a run's protocol checks call. A tool is called only for a
 * check that runs, so one named for a check left out is not sent at all.
 * `checkIds` absent means every check.
 */
export function probesForRun(
  probes: ConformanceProbes,
  checkIds: readonly string[] | undefined,
): ConformanceProbes {
  const runs = (key: ConformanceProbeKey) =>
    checkIds === undefined ||
    PROBE_CHECKS[key].some((id) => checkIds.includes(id));
  return Object.fromEntries(
    PROBE_KEYS.filter((key) => probes[key] && runs(key)).map((key) => [
      key,
      probes[key],
    ]),
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
  const [changed, setChanged] = useState<Record<string, ConformanceProbes>>({});
  const probesFor = useCallback(
    (serverName: string) => changed[serverName] ?? readStoredProbes(serverName),
    [changed],
  );
  const setProbes = useCallback(
    (serverName: string, probes: ConformanceProbes) => {
      setChanged((prev) => ({ ...prev, [serverName]: probes }));
      writeStoredProbes(serverName, probes);
    },
    [],
  );
  return { probesFor, setProbes };
}
