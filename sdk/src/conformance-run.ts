/**
 * Composite conformance execution: one requested-suite snapshot, independent
 * Protocol / Apps / Tasks / OAuth runners, and a pooled `ConformanceRunReportV1`.
 *
 * Existing runner classes and `ConformanceReport` v1 stay compatible. Directory
 * readiness is deliberately absent — it grades publisher policy and must never
 * enter the conformance score or CI verdict.
 */

import { MCPAppsConformanceTest } from "./apps-conformance/runner.js";
import type { MCPAppsConformanceConfig } from "./apps-conformance/types.js";
import { toConformanceReport, type ConformanceReport } from "./conformance-reporting.js";
import {
  scoreFromAppsResult,
  scoreFromOAuthResult,
  scoreFromProtocolResult,
  scoreFromTasksResult,
} from "./conformance-score.js";
import type { MCPServerConfig } from "./mcp-client-manager/index.js";
import { MCPConformanceTest } from "./mcp-conformance/runner.js";
import type { MCPConformanceConfig } from "./mcp-conformance/types.js";
import { OAuthConformanceTest } from "./oauth-conformance/runner.js";
import type { OAuthConformanceConfig } from "./oauth-conformance/types.js";
import { MCPTasksConformanceTest } from "./tasks-conformance/runner.js";
import type { MCPTasksConformanceConfig } from "./tasks-conformance/types.js";
import {
  buildConformanceRunReport,
  normalizeConformanceSuites,
  type ConformanceRunReportV1,
  type ConformanceSuiteKind,
} from "./conformance-run-types.js";

export {
  buildConformanceRunReport,
  CONFORMANCE_RUN_SCHEMA_VERSION,
  CONFORMANCE_SUITE_KINDS,
  DEFAULT_CONFORMANCE_SUITES,
  normalizeConformanceSuites,
} from "./conformance-run-types.js";
export type {
  ConformanceRunReportV1,
  ConformanceSuiteKind,
} from "./conformance-run-types.js";

export type ConformanceRunProgress = {
  suiteKind: ConformanceSuiteKind;
  status: "running" | "completed" | "failed" | "skipped";
  report?: ConformanceReport;
  error?: string;
};

export type RunConformanceConfig = {
  server: MCPServerConfig;
  suites?: ConformanceSuiteKind[];
  protocolVersion?: MCPConformanceConfig["protocolVersion"];
  protocol?: Partial<Omit<MCPConformanceConfig, "url" | "command" | "args">>;
  apps?: Partial<Omit<MCPAppsConformanceConfig, "url" | "command" | "args">>;
  tasks?: Partial<Omit<MCPTasksConformanceConfig, "url" | "command" | "args">>;
  oauth?: OAuthConformanceConfig;
  engineVersion?: string;
  onProgress?: (event: ConformanceRunProgress) => void | Promise<void>;
};

function isHeaderRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

async function runSuite(
  kind: ConformanceSuiteKind,
  config: RunConformanceConfig,
): Promise<ConformanceReport> {
  const server = config.server;
  switch (kind) {
    case "protocol": {
      // MCPConformanceConfig names its target `serverUrl`, while
      // MCPServerConfig carries `url`. Spreading the server config verbatim
      // left `serverUrl` undefined and normalization crashed on `.trim()`
      // before dialing anything, so map the HTTP fields explicitly. An absent
      // `protocolVersion` stays absent: the suite then adopts the version the
      // server actually negotiates instead of pinning one.
      const http = server as {
        url?: string | URL;
        accessToken?: string;
        requestInit?: { headers?: unknown };
      };
      const headers = http.requestInit?.headers;
      const result = await new MCPConformanceTest({
        ...(http.url !== undefined ? { serverUrl: String(http.url) } : {}),
        ...(http.accessToken !== undefined
          ? { accessToken: http.accessToken }
          : {}),
        ...(isHeaderRecord(headers) ? { customHeaders: headers } : {}),
        ...config.protocol,
        ...(config.protocolVersion
          ? { protocolVersion: config.protocolVersion }
          : {}),
      } as MCPConformanceConfig).run();
      const report = toConformanceReport(result);
      return { ...report, score: scoreFromProtocolResult(result) };
    }
    case "apps": {
      const result = await new MCPAppsConformanceTest({
        ...server,
        ...config.apps,
      } as MCPAppsConformanceConfig).run();
      const report = toConformanceReport(result);
      return { ...report, score: scoreFromAppsResult(result) };
    }
    case "tasks": {
      const result = await new MCPTasksConformanceTest({
        ...server,
        ...config.tasks,
      } as MCPTasksConformanceConfig).run();
      const report = toConformanceReport(result);
      return { ...report, score: scoreFromTasksResult(result) };
    }
    case "oauth": {
      if (!config.oauth) {
        throw new Error(
          "OAuth is opt-in: pass an oauth config with an explicit auth strategy",
        );
      }
      const result = await new OAuthConformanceTest(config.oauth).run();
      const report = toConformanceReport(result);
      return { ...report, score: scoreFromOAuthResult(result) };
    }
  }
}

/**
 * Run the requested suites independently (Protocol, Apps, and Tasks in
 * parallel; OAuth only when configured) and pool the existing v1 reports.
 */
export async function runConformance(
  config: RunConformanceConfig,
): Promise<ConformanceRunReportV1> {
  const requestedSuites = normalizeConformanceSuites(config.suites);
  if (requestedSuites.includes("oauth") && !config.oauth) {
    throw new Error(
      "OAuth is opt-in and requires an explicit supported auth strategy",
    );
  }
  const startedAt = Date.now();
  const reports: Partial<Record<ConformanceSuiteKind, ConformanceReport>> = {};
  const independent = requestedSuites.filter((kind) => kind !== "oauth");

  await Promise.all(
    independent.map(async (kind) => {
      await config.onProgress?.({ suiteKind: kind, status: "running" });
      try {
        const report = await runSuite(kind, config);
        reports[kind] = report;
        await config.onProgress?.({
          suiteKind: kind,
          status: "completed",
          report,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await config.onProgress?.({
          suiteKind: kind,
          status: "failed",
          error: message,
        });
      }
    }),
  );

  if (requestedSuites.includes("oauth")) {
    await config.onProgress?.({ suiteKind: "oauth", status: "running" });
    try {
      const report = await runSuite("oauth", config);
      reports.oauth = report;
      await config.onProgress?.({
        suiteKind: "oauth",
        status: "completed",
        report,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await config.onProgress?.({
        suiteKind: "oauth",
        status: "failed",
        error: message,
      });
    }
  }

  return buildConformanceRunReport({
    requestedSuites,
    reports,
    startedAt,
    engineVersion: config.engineVersion,
  });
}
