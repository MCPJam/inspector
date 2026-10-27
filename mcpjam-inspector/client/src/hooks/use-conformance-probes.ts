/**
 * The tools an operator names as safe for the protocol suite to call, kept
 * per server.
 *
 * Two 2026-07-28 checks can only be observed on a tool call — one that emits
 * logs (`modern-logs-require-log-level`) and one that asks for input
 * (`modern-undeclared-capability-error`) — and the SDK never picks a tool on
 * its own, because nothing a server advertises says whether calling a tool
 * charges a card or deletes a row. Without a named tool both checks report
 * could-not-run, so no 2026 server could ever read PASSED from this page.
 *
 * Kept in browser storage, keyed by server name, so a choice survives a reload
 * and every later run reuses it without asking again. Storage can be missing
 * or throw (private windows, blocked site data); the page then behaves as if
 * nothing was chosen, which is exactly the pre-probe default.
 */
import { useCallback, useEffect, useState } from "react";
import type { MCPConformanceConfig } from "@mcpjam/sdk";

export type ConformanceProbe = NonNullable<MCPConformanceConfig["logProbe"]>;

export type ConformanceProbes = Pick<
  MCPConformanceConfig,
  "logProbe" | "inputRequiredProbe"
>;

export type ConformanceProbeKey = keyof ConformanceProbes;

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

/** Read what was saved for `serverName`, dropping anything malformed. */
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

export function useConformanceProbes(serverName: string): {
  probes: ConformanceProbes;
  setProbes: (next: ConformanceProbes) => void;
} {
  const [probes, setProbesState] = useState<ConformanceProbes>(() =>
    readStoredProbes(serverName),
  );

  // A server switch loads that server's own choice, never the previous one's.
  useEffect(() => {
    setProbesState(readStoredProbes(serverName));
  }, [serverName]);

  const setProbes = useCallback(
    (next: ConformanceProbes) => {
      setProbesState(next);
      writeStoredProbes(serverName, next);
    },
    [serverName],
  );

  return { probes, setProbes };
}
