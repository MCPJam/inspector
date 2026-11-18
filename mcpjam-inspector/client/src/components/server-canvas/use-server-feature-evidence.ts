import { useMemo } from "react";
import {
  SERVER_FEATURE_CATALOG,
  checkEvidenceFromDigest,
  evaluateServerFeatures,
  listEvidenceContexts,
  selectServerEvidence,
  type CheckResultEvidence,
  type ConformanceSuiteKey,
  type FeatureSetupKind,
  type SelectedServerEvidence,
  type ServerFeatureEvaluation,
} from "@mcpjam/sdk/browser";
import { useSoftQuery } from "@/hooks/use-soft-query";

/** The Convex read behind the page. */
export const SERVER_FEATURE_EVIDENCE_QUERY = "serverFeatureEvidence:getForServer";

export interface ConformanceRunDigest {
  runId: string;
  createdAt: number;
  completedAt?: number | null;
  status: string;
  protocolVersion?: string | null;
  suites: ReadonlyArray<{
    suiteKind: string;
    protocolVersion?: string | null;
    cases: ReadonlyArray<{ id: string; status: string }>;
  }>;
}

/** `serverFeatureEvidence:getForServer`'s result. */
export interface ServerFeatureEvidenceResponse {
  inspection: unknown;
  probeResults: unknown;
  observations: unknown;
  latestConformanceRun: ConformanceRunDigest | null;
}

export interface DerivedServerFeatureEvidence {
  evaluation: ServerFeatureEvaluation;
  selected: SelectedServerEvidence;
  latestRun?: { runId: string; at: number; status: string };
  /**
   * Changes whenever saved evidence for this server changes: a new capture,
   * a probe result, a failed attempt. Refresh waits for it to move. It
   * reads every context, so choosing another context does not move it.
   */
  stamp: string;
}

export interface ServerFeatureEvidenceState extends DerivedServerFeatureEvidence {
  status: "loading" | "ready" | "error";
  error?: Error;
}

/** Check results from the latest run, each suite at its own version. */
export function checksFromRun(
  run: ConformanceRunDigest | null | undefined,
): CheckResultEvidence[] {
  if (!run) return [];
  const runAt = run.completedAt ?? run.createdAt;
  return run.suites.flatMap((suite) =>
    checkEvidenceFromDigest({
      runId: run.runId,
      runAt,
      protocolVersion:
        suite.protocolVersion ?? run.protocolVersion ?? undefined,
      suites: [suite],
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * The server's saved evidence in brief, whatever context the page shows:
 * the latest capture and capture attempt, every context's newest time, and
 * each probe row's last attempt and failures.
 */
export function evidenceStamp(
  data: ServerFeatureEvidenceResponse | null | undefined,
): string {
  const inspection = isRecord(data?.inspection) ? data.inspection : undefined;
  const attempt = isRecord(inspection?.latestAttempt)
    ? inspection.latestAttempt
    : undefined;
  return JSON.stringify([
    inspection?.latestCapturedAt ?? null,
    attempt?.at ?? null,
    listEvidenceContexts(data ?? {}).map((option) => [
      option.contextHash,
      option.updatedAt ?? null,
    ]),
    records(data?.probeResults).map((row) => [
      row.contextHash ?? null,
      row.lastAttemptAt ?? null,
      records(row.failures).map((failure) => failure.at ?? null),
    ]),
  ]);
}

/**
 * Saved evidence for one server → the evaluation for one capture context.
 * Pure: the page re-runs it only when the data, the context or the live
 * connection changes.
 */
export interface ServerFeatureEvidenceOptions {
  connected: boolean;
  contextHash?: string;
  /** Setup the server has saved in MCPJam; a precondition, never evidence. */
  configured?: readonly FeatureSetupKind[];
  /** Setup the page can send the reader to. */
  setupOffered?: readonly FeatureSetupKind[];
  /** Conformance suites Run checks can run. */
  checksOffered?: readonly ConformanceSuiteKey[];
}

export function deriveServerFeatureEvidence(
  data: ServerFeatureEvidenceResponse | null | undefined,
  options: ServerFeatureEvidenceOptions,
): DerivedServerFeatureEvidence {
  const run = data?.latestConformanceRun ?? null;
  const selected = selectServerEvidence(
    {
      inspection: data?.inspection ?? undefined,
      probeResults: data?.probeResults,
      observations: data?.observations,
    },
    {
      connected: options.connected,
      contextHash: options.contextHash,
      checks: checksFromRun(run),
      configured: options.configured,
      setupOffered: options.setupOffered,
      checksOffered: options.checksOffered,
    },
  );
  const evaluation = evaluateServerFeatures(
    SERVER_FEATURE_CATALOG,
    selected.input,
  );
  return {
    evaluation,
    selected,
    latestRun: run
      ? {
          runId: run.runId,
          at: run.completedAt ?? run.createdAt,
          status: run.status,
        }
      : undefined,
    stamp: evidenceStamp(data),
  };
}

/**
 * Subscribes to the server's saved evidence and evaluates it for one
 * context: the one asked for, or the latest capture's. Opening the page
 * reads saved evidence only; nothing here talks to the server.
 *
 * A failed read leaves the rest of the page usable, so it comes back as
 * `status: "error"` instead of throwing.
 */
export function useServerFeatureEvidence(
  projectId: string | null,
  serverId: string | null,
  options: ServerFeatureEvidenceOptions,
): ServerFeatureEvidenceState {
  const result = useSoftQuery<ServerFeatureEvidenceResponse | null>(
    SERVER_FEATURE_EVIDENCE_QUERY,
    projectId && serverId ? { projectId, serverId } : "skip",
  );
  const { connected, contextHash, configured, setupOffered, checksOffered } =
    options;
  const derived = useMemo(
    () =>
      deriveServerFeatureEvidence(result.data, {
        connected,
        contextHash,
        configured,
        setupOffered,
        checksOffered,
      }),
    [result.data, connected, contextHash, configured, setupOffered, checksOffered],
  );
  return {
    ...derived,
    status: result.error
      ? "error"
      : result.data === undefined
        ? "loading"
        : "ready",
    error: result.error,
  };
}
