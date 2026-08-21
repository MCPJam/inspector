/**
 * Upload a composite conformance run into MCPJam, patterned after eval ingest.
 *
 * Progressive: start → one report per suite → finalize. One-shot
 * `reportConformanceRun` wraps that. Reporting failure is the caller's
 * problem: CLI `--require-upload` turns it into a hard error; otherwise the
 * test verdict is unchanged.
 */

import type { ConformanceReport } from "./conformance-reporting.js";
import {
  detectConformanceCiMetadata,
  githubActionExternalRunId,
  type ConformanceCiMetadata,
} from "./conformance-ci.js";
import type {
  ConformanceRunReportV1,
  ConformanceSuiteKind,
} from "./conformance-run-types.js";

export const DEFAULT_MCPJAM_BASE_URL = "https://app.mcpjam.com";
export const DEFAULT_MCPJAM_PROJECT = "default";

export type ConformanceRunSource =
  | "ui"
  | "sdk"
  | "cli"
  | "github_action"
  | "github_app"
  | "api";

export type ConformanceTargetInput = {
  kind: "server" | "github_repo" | "external";
  serverId?: string;
  githubCheckRepoConfigId?: string;
  serverRef?: string;
  serverUrl?: string;
};

export type ReportConformanceRunOptions = {
  apiKey?: string;
  baseUrl?: string;
  project?: string;
  /**
   * Force the source. Overrides CI detection — pass it only when the caller
   * genuinely knows better than the environment does.
   */
  source?: ConformanceRunSource;
  /**
   * What to file as when the environment says nothing. A caller that is
   * merely naming ITSELF (the CLI saying "cli") wants this, not `source`:
   * running that same CLI inside GitHub Actions should still be recorded as
   * `github_action`, which is what carries the CI identity and the
   * re-run-idempotent external run id.
   */
  defaultSource?: ConformanceRunSource;
  target?: ConformanceTargetInput;
  serverUrl?: string;
  serverRef?: string;
  actorLabel?: string;
  ci?: ConformanceCiMetadata;
  externalRunId?: string;
  timeoutMs?: number;
};

export type ReportConformanceRunOutput = {
  runId: string;
  projectId?: string;
  runUrl?: string;
  outcome?: string;
  score?: number | null;
  reused?: boolean;
};

type RuntimeConfig = {
  apiKey: string;
  baseUrl: string;
  project: string;
  timeoutMs: number;
};

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resolveApiKey(input: Pick<ReportConformanceRunOptions, "apiKey">) {
  return input.apiKey ?? process.env.MCPJAM_API_KEY;
}

function resolveBaseUrl(input: Pick<ReportConformanceRunOptions, "baseUrl">) {
  return trimTrailingSlash(
    input.baseUrl ?? process.env.MCPJAM_BASE_URL ?? DEFAULT_MCPJAM_BASE_URL
  );
}

function resolveProject(input: Pick<ReportConformanceRunOptions, "project">) {
  const project = input.project ?? process.env.MCPJAM_PROJECT_ID;
  const trimmed = typeof project === "string" ? project.trim() : "";
  return trimmed || DEFAULT_MCPJAM_PROJECT;
}

function ingestPath(config: RuntimeConfig, suffix: string): string {
  return `/api/v1/projects/${encodeURIComponent(
    config.project
  )}/conformance-ingest/${suffix}`;
}

function detectSource(
  options: ReportConformanceRunOptions
): ConformanceRunSource {
  if (options.source) return options.source;
  if (
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.GITHUB_ACTIONS === "1"
  ) {
    return "github_action";
  }
  return options.defaultSource ?? "sdk";
}

async function postJson(
  config: RuntimeConfig,
  suffix: string,
  body: unknown
): Promise<Record<string, unknown>> {
  const endpoint = `${config.baseUrl}${ingestPath(config, suffix)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      const message =
        typeof parsed.message === "string"
          ? parsed.message
          : typeof parsed.error === "string"
          ? parsed.error
          : `Conformance ingest failed (${response.status})`;
      throw new Error(message);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export function isConformanceReportingConfigured(
  options: Pick<ReportConformanceRunOptions, "apiKey"> = {}
): boolean {
  return Boolean(resolveApiKey(options));
}

export async function startConformanceRun(
  report: Pick<
    ConformanceRunReportV1,
    "requestedSuites" | "protocolVersion" | "engineVersion"
  >,
  options: ReportConformanceRunOptions = {}
): Promise<ReportConformanceRunOutput> {
  const apiKey = resolveApiKey(options);
  if (!apiKey) {
    throw new Error("MCPJAM_API_KEY is required to upload conformance results");
  }
  const config: RuntimeConfig = {
    apiKey,
    baseUrl: resolveBaseUrl(options),
    project: resolveProject(options),
    timeoutMs: options.timeoutMs ?? 30_000,
  };
  const ci = options.ci ?? detectConformanceCiMetadata();
  const source = detectSource(options);
  const externalRunId =
    options.externalRunId ??
    (source === "github_action" ? githubActionExternalRunId() : undefined);
  const started = await postJson(config, "runs/start", {
    target: options.target ?? {
      kind: "external",
      serverUrl: options.serverUrl,
      serverRef: options.serverRef,
    },
    source,
    requestedSuites: report.requestedSuites,
    protocolVersion: report.protocolVersion,
    engineVersion: report.engineVersion,
    actorLabel: options.actorLabel,
    ci,
    externalRunId,
  });
  return {
    runId: String(started.runId),
    projectId:
      typeof started.projectId === "string" ? started.projectId : undefined,
    runUrl: typeof started.runUrl === "string" ? started.runUrl : undefined,
    reused: started.reused === true,
  };
}

export async function uploadConformanceSuiteReport(
  runId: string,
  suiteKind: ConformanceSuiteKind,
  report: ConformanceReport,
  options: ReportConformanceRunOptions = {}
): Promise<void> {
  const apiKey = resolveApiKey(options);
  if (!apiKey) {
    throw new Error("MCPJAM_API_KEY is required to upload conformance results");
  }
  const config: RuntimeConfig = {
    apiKey,
    baseUrl: resolveBaseUrl(options),
    project: resolveProject(options),
    timeoutMs: options.timeoutMs ?? 30_000,
  };
  await postJson(config, "runs/reports", {
    runId,
    suiteKind,
    report,
    durationMs: report.durationMs,
  });
}

export async function heartbeatConformanceRun(
  runId: string,
  options: ReportConformanceRunOptions = {}
): Promise<void> {
  const apiKey = resolveApiKey(options);
  if (!apiKey) {
    throw new Error("MCPJAM_API_KEY is required to upload conformance results");
  }
  const config: RuntimeConfig = {
    apiKey,
    baseUrl: resolveBaseUrl(options),
    project: resolveProject(options),
    timeoutMs: options.timeoutMs ?? 30_000,
  };
  await postJson(config, "runs/heartbeat", { runId });
}

export async function finalizeConformanceRun(
  runId: string,
  options: ReportConformanceRunOptions = {}
): Promise<ReportConformanceRunOutput> {
  const apiKey = resolveApiKey(options);
  if (!apiKey) {
    throw new Error("MCPJAM_API_KEY is required to upload conformance results");
  }
  const config: RuntimeConfig = {
    apiKey,
    baseUrl: resolveBaseUrl(options),
    project: resolveProject(options),
    timeoutMs: options.timeoutMs ?? 30_000,
  };
  const finalized = await postJson(config, "runs/finalize", { runId });
  return {
    runId: String(finalized.runId ?? runId),
    projectId:
      typeof finalized.projectId === "string" ? finalized.projectId : undefined,
    runUrl: typeof finalized.runUrl === "string" ? finalized.runUrl : undefined,
    outcome:
      typeof finalized.outcome === "string" ? finalized.outcome : undefined,
    score:
      typeof finalized.score === "number" || finalized.score === null
        ? (finalized.score as number | null)
        : undefined,
  };
}

export async function reportConformanceRun(
  report: ConformanceRunReportV1,
  options: ReportConformanceRunOptions = {}
): Promise<ReportConformanceRunOutput> {
  const started = await startConformanceRun(report, options);
  const suites = Object.entries(report.reports) as Array<
    [ConformanceSuiteKind, ConformanceReport]
  >;
  for (const [suiteKind, suiteReport] of suites) {
    await uploadConformanceSuiteReport(
      started.runId,
      suiteKind,
      suiteReport,
      options
    );
    await heartbeatConformanceRun(started.runId, options);
  }
  return await finalizeConformanceRun(started.runId, options);
}

export async function reportConformanceRunSafely(
  report: ConformanceRunReportV1,
  options: ReportConformanceRunOptions = {}
): Promise<ReportConformanceRunOutput | null> {
  try {
    return await reportConformanceRun(report, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: conformance upload failed: ${message}\n`);
    return null;
  }
}
