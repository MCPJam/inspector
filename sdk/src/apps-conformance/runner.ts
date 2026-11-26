import { readUiResources } from "./resource-reads.js";
import { withAbortSignalFetch } from "../abort-signal.js";
import { http1Fetch } from "../http1-fetch.js";
import { captureConformanceRun } from "../telemetry.js";
import { isAuthorizationRefusal } from "../conformance-authorization.js";
import { credentialsFromServerConfig } from "../conformance-login.js";
import {
  buildOutcomeSummary,
  decideConformanceOutcome,
  isUnrunCheck,
} from "../conformance-outcome.js";
import type { MCPResource } from "../mcp-client-manager/index.js";
import { withEphemeralClient } from "../operations.js";
import {
  MCP_APPS_CHECK_IDS,
  MCP_APPS_CHECK_CATEGORIES,
  type MCPAppsCheckId,
  type MCPAppsCheckResult,
  type MCPAppsConformanceConfig,
  type MCPAppsConformanceResult,
  type MCPAppsResourceReadOutcome,
  type NormalizedMCPAppsConformanceConfig,
} from "./types.js";
import { normalizeMCPAppsConformanceConfig } from "./validation.js";
import {
  blockedSkip,
  errorMessage,
  failedResult,
  loginSkip,
  skippedResult,
} from "./check-results.js";
import {
  gradeMCPApps,
  planMCPAppsResourceReads,
  type MCPListedTool,
} from "./grading.js";

export { APPS_CHECK_METADATA } from "./check-results.js";

function buildCheckSelection(
  config: NormalizedMCPAppsConformanceConfig,
): Set<MCPAppsCheckId> {
  return new Set(config.checkIds ?? MCP_APPS_CHECK_IDS);
}

function summarizeChecks(checks: MCPAppsCheckResult[]) {
  return Object.fromEntries(
    MCP_APPS_CHECK_CATEGORIES.map((category) => {
      const categoryChecks = checks.filter((check) => check.category === category);
      return [
        category,
        {
          total: categoryChecks.length,
          passed: categoryChecks.filter((check) => check.status === "passed").length,
          failed: categoryChecks.filter((check) => check.status === "failed").length,
          skipped: categoryChecks.filter((check) => check.status === "skipped").length,
          couldNotRun: categoryChecks.filter(isUnrunCheck).length,
        },
      ];
    }),
  ) as MCPAppsConformanceResult["categorySummary"];
}

const buildSummary = buildOutcomeSummary;

function buildConnectionFailureResult(
  config: NormalizedMCPAppsConformanceConfig,
  error: unknown,
  startedAt: number,
): MCPAppsConformanceResult {
  const selectedCheckIds = buildCheckSelection(config);
  const failureCheckId = selectedCheckIds.has("ui-tools-present")
    ? "ui-tools-present"
    : selectedCheckIds.values().next().value;
  const checks: MCPAppsCheckResult[] = [];
  // Refused for credentials: no check reached the server, so none failed.
  const authorizationRefused = isAuthorizationRefusal(error);

  for (const checkId of selectedCheckIds) {
    if (authorizationRefused) {
      checks.push(
        loginSkip(
          checkId,
          credentialsFromServerConfig(config.serverConfig),
          error,
        ),
      );
    } else if (checkId === failureCheckId) {
      checks.push(
        failedResult(
          checkId,
          Date.now() - startedAt,
          errorMessage(error),
          undefined,
          error,
        ),
      );
    } else {
      checks.push(
        failureCheckId
          ? blockedSkip(checkId, failureCheckId)
          : skippedResult(
              checkId,
              "could-not-run",
              "Skipping check because the MCP server could not be connected",
            ),
      );
    }
  }

  // One check carries the connection failure and the rest are skipped, so the
  // shared verdict lands on "failed" — same as the hardcoded value it replaces,
  // but derived rather than asserted. An authorization refusal leaves every
  // check unrun, so the same derivation lands on "incomplete".
  const verdict = decideConformanceOutcome(checks);

  return {
    passed: verdict.outcome === "passed",
    outcome: verdict.outcome,
    ...(verdict.incompleteReason
      ? { incompleteReason: verdict.incompleteReason }
      : {}),
    target: config.target,
    checks,
    summary: buildSummary(checks),
    durationMs: Date.now() - startedAt,
    categorySummary: summarizeChecks(checks),
    discovery: {
      toolCount: 0,
      uiToolCount: 0,
      listedResourceCount: 0,
      listedUiResourceCount: 0,
      checkedUiResourceCount: 0,
    },
  };
}

export class MCPAppsConformanceTest {
  private readonly config: NormalizedMCPAppsConformanceConfig;
  private readonly suppressTelemetry: boolean;

  constructor(config: MCPAppsConformanceConfig) {
    this.config = normalizeMCPAppsConformanceConfig(config);
    // The normalized config drops it, so read it from the caller's config.
    this.suppressTelemetry = config.__suppressTelemetry === true;
  }

  async run(): Promise<MCPAppsConformanceResult> {
    const signal = this.config.signal;
    signal?.throwIfAborted();
    if (!this.suppressTelemetry)
      void captureConformanceRun("sdk", { suite: "apps", mode: "single" });
    const serverConfig = this.config.serverConfig;
    const runConfig =
      signal && "url" in serverConfig
        ? {
            ...serverConfig,
            baseFetch: withAbortSignalFetch(
              serverConfig.baseFetch ?? http1Fetch,
              signal
            ),
          }
        : serverConfig;
    const startedAt = Date.now();
    const selectedCheckIds = buildCheckSelection(this.config);

    try {
      return await withEphemeralClient(
        runConfig,
        async (manager, serverId) => {
          signal?.throwIfAborted();
          let tools: MCPListedTool[] = [];
          let resources: MCPResource[] = [];
          let toolsError: unknown;
          let resourcesError: unknown;

          try {
            const result = await manager.listTools(serverId, undefined, {
              signal,
            });
            tools = result.tools ?? [];
          } catch (error) {
            signal?.throwIfAborted();
            toolsError = error;
          }

          signal?.throwIfAborted();
          try {
            const result = await manager.listResources(serverId, undefined, {
              signal,
            });
            resources = result.resources ?? [];
          } catch (error) {
            signal?.throwIfAborted();
            resourcesError = error;
          }

          signal?.throwIfAborted();
          const plan = planMCPAppsResourceReads(tools, resources);

          let readOutcomes: MCPAppsResourceReadOutcome[] = [];
          if (
            (selectedCheckIds.has("ui-resources-readable") ||
              selectedCheckIds.has("ui-resource-contents-valid") ||
              selectedCheckIds.has("ui-resource-meta-valid")) &&
            plan.uris.length > 0
          ) {
            readOutcomes = await readUiResources(
              manager,
              serverId,
              plan.uris,
              plan.uiTools,
              plan.listedUiResourceUris,
              signal
            );
          }

          signal?.throwIfAborted();
          const { checks, readiness, passedAdvice, discovery } = gradeMCPApps({
            tools,
            toolsError,
            resources,
            resourcesError,
            readOutcomes,
            checkIds: this.config.checkIds,
            credentials: credentialsFromServerConfig(this.config.serverConfig),
          });

          // A check that COULD NOT RUN is neither a violation nor a pass: the
          // obligation went untested, so the run is `incomplete`.
          const verdict = decideConformanceOutcome(checks);
          // The negotiated revision, so the score label is data. Only the
          // success path can state one — a failed connection established none.
          // Optional-called: this is best-effort metadata for a LABEL, and a
          // partial manager (tests stub only what their check needs) must
          // yield "no version", never a failed run.
          const negotiatedProtocolVersion =
            manager.getInitializationInfo?.(serverId)?.protocolVersion;

          return {
            passed: verdict.outcome === "passed",
            outcome: verdict.outcome,
            ...(verdict.incompleteReason
              ? { incompleteReason: verdict.incompleteReason }
              : {}),
            target: this.config.target,
            ...(negotiatedProtocolVersion !== undefined
              ? { protocolVersion: negotiatedProtocolVersion }
              : {}),
            checks,
            ...(readiness.length > 0 ? { readiness } : {}),
            ...(passedAdvice.length > 0 ? { passedAdvice } : {}),
            summary: buildSummary(checks),
            durationMs: Date.now() - startedAt,
            categorySummary: summarizeChecks(checks),
            discovery,
          };
        },
        {
          serverId: "__apps_conformance__",
          clientName: "mcpjam-sdk-apps-conformance",
          timeout: this.config.timeout,
          signal,
          rpcLogger: this.config.serverConfig.rpcLogger,
        },
      );
    } catch (error) {
      signal?.throwIfAborted();
      return buildConnectionFailureResult(this.config, error, startedAt);
    }
  }
}
