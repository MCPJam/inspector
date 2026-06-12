/**
 * probe-iteration.ts — execution path for `widget_probe` test cases
 * (synthetic monitors).
 *
 * A probe skips the LLM entirely: it calls one MCP tool with pinned
 * arguments, renders the result in the MCP App browser harness, and gates
 * the iteration with the widget render predicates. The iteration is
 * finalized through the SAME recorder/finalize pipeline as LLM iterations,
 * so screenshot upload, artifact fanout, and the replay UI work unchanged.
 *
 * Deliberately NOT built on `createBrowserSessionContext`: that context
 * requires a driver model and performs a per-iteration capability lookup
 * purely to wire Computer Use tools a probe never uses — and its direct
 * tool-result handler silently skips non-renderable tools, where a probe
 * must record an explicit `no_ui_resource` observation.
 */

import type { ModelMessage } from "ai";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { ConvexHttpClient } from "convex/browser";
import {
  evaluatePredicates,
  allPredicatesPassed,
  summarizeRenderObservations,
  type IterationTranscript,
  type ToolErrorRecord,
} from "@/shared/eval-matching";
import type { ProbeConfig } from "@/shared/probe-config";
import type { RunnerWidgetRenderObservation } from "@/shared/eval-trace";
import { McpAppBrowserHarness } from "../../utils/mcp-app-browser-harness";
import {
  isRenderableMcpAppTool,
  renderMcpAppToolResult,
} from "../../utils/mcp-app-render-observation";
import { logger } from "../../utils/logger";
import { finalizeEvalIteration } from "./finalize-iteration";
import type { SuiteRunRecorder } from "./recorder";
import type { EvaluationResult } from "./types";
import type { EvalIterationOutcome, EvalTestCase } from "../evals-runner";

/** Stable error token for "the probe's server isn't connected to this run". */
export const PROBE_SERVER_NOT_CONNECTED = "probe_server_not_connected";

export interface RunProbeTestCaseParams {
  test: EvalTestCase;
  /**
   * Manager key for the probe's server, resolved by the caller against the
   * run environment's serverBindings (id first, display-name fallback).
   * `undefined` ⇒ the server isn't connected; every iteration records a
   * failed row instead of throwing the whole suite run away.
   */
  resolvedServerKey: string | undefined;
  mcpClientManager: MCPClientManager;
  recorder: SuiteRunRecorder | null;
  convexClient: ConvexHttpClient;
  testCaseId?: string;
  runId: string | null;
  abortSignal?: AbortSignal;
  /** Suite-level OpenAI Apps SDK compat shim flag (host-config resolved). */
  injectOpenAiCompat?: boolean;
}

/** First text block of a CallToolResult, for content-error messages. */
function extractResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      return (part as { text: string }).text;
    }
  }
  return undefined;
}

/**
 * Run every iteration of one widget-probe case. Mirrors the contract of the
 * LLM `runTestCase` path: one `EvalIterationOutcome` per iteration, rows
 * paired with precreated iterations by `testCaseId + iterationNumber` (the
 * recorder's fallback matcher — probes pass no `testCaseSnapshot`, so the
 * backend's sentinel provider/model never has to match anything here).
 */
export async function runProbeTestCase(
  params: RunProbeTestCaseParams,
): Promise<EvalIterationOutcome[]> {
  const { test } = params;
  const runs = Math.max(1, Math.floor(test.runs || 1));
  const outcomes: EvalIterationOutcome[] = [];
  for (let runIndex = 0; runIndex < runs; runIndex++) {
    if (params.abortSignal?.aborted) {
      break;
    }
    outcomes.push(await runProbeIteration(params, runIndex));
  }
  return outcomes;
}

async function runProbeIteration(
  params: RunProbeTestCaseParams,
  runIndex: number,
): Promise<EvalIterationOutcome> {
  const {
    test,
    resolvedServerKey,
    mcpClientManager,
    recorder,
    convexClient,
  } = params;
  const probeConfig = test.probeConfig as ProbeConfig;
  const testCaseId = test.testCaseId || params.testCaseId;
  const iterationNumber = runIndex + 1;
  const startedAt = Date.now();
  const probeArguments = (probeConfig.arguments ?? {}) as Record<
    string,
    unknown
  >;

  const iterationId = recorder
    ? await recorder.startIteration({
        testCaseId,
        iterationNumber,
        startedAt,
      })
    : undefined;

  const toolErrors: ToolErrorRecord[] = [];
  let observation: RunnerWidgetRenderObservation | undefined;
  let iterationError: string | undefined;
  let toolCallOk = false;

  try {
    if (!resolvedServerKey) {
      iterationError = `${PROBE_SERVER_NOT_CONNECTED}: "${probeConfig.serverName}" is not connected in this run's environment`;
    } else {
      // ── pinned tool call ─────────────────────────────────────────────
      let rawResult: unknown;
      try {
        rawResult = await mcpClientManager.executeTool(
          resolvedServerKey,
          probeConfig.toolName,
          probeArguments,
        );
        const isError =
          !!rawResult &&
          typeof rawResult === "object" &&
          (rawResult as { isError?: unknown }).isError === true;
        if (isError) {
          toolErrors.push({
            toolName: probeConfig.toolName,
            kind: "content-error",
            message: extractResultText(rawResult),
          });
        } else {
          toolCallOk = true;
        }
      } catch (error) {
        toolErrors.push({
          toolName: probeConfig.toolName,
          kind: "protocol-error",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      // ── render the result in the harness ─────────────────────────────
      // Only after a clean tool call: an errored call has no widget data
      // worth mounting, and the render predicates fail closed without an
      // observation, which is the verdict we want.
      if (toolCallOk) {
        const toolCallId = `probe-${iterationNumber}-${startedAt}`;
        const toolMetadata =
          mcpClientManager.getAllToolsMetadata(resolvedServerKey)?.[
            probeConfig.toolName
          ] ?? {};
        if (!isRenderableMcpAppTool(toolMetadata)) {
          // Explicit observation (not a silent skip): the probe's whole
          // point is to attest the widget, so "this tool declares no UI
          // resource" must be a recorded, predicate-visible outcome.
          observation = {
            toolCallId,
            toolName: probeConfig.toolName,
            serverId: resolvedServerKey,
            status: "no_ui_resource",
            elapsedMs: 0,
            ts: Date.now(),
            promptIndex: 0,
          };
        } else {
          const harness = new McpAppBrowserHarness({
            callTool: (serverId, name, args) =>
              mcpClientManager.executeTool(serverId, name, args),
            ...(probeConfig.renderTimeoutMs
              ? { budgets: { renderTimeoutMs: probeConfig.renderTimeoutMs } }
              : {}),
          });
          try {
            const rendered = await renderMcpAppToolResult({
              toolCallId,
              toolName: probeConfig.toolName,
              serverId: resolvedServerKey,
              toolMetadata,
              output: rawResult,
              toolInput: probeArguments,
              mcpClientManager,
              injectOpenAiCompat: params.injectOpenAiCompat,
              harness,
              keepMounted: false,
            });
            observation = { ...rendered, promptIndex: 0 };
          } finally {
            await harness.dispose().catch(() => {});
          }
        }
      }
    }
  } catch (error) {
    logger.error("[evals] probe iteration failed", error);
    iterationError =
      iterationError ??
      (error instanceof Error ? error.message : String(error));
  }

  // ── verdict ──────────────────────────────────────────────────────────
  // Same evaluator as every other path. The transcript is assembled
  // directly (no trace exists to derive it from). The pinned call is only
  // recorded when an MCP call actually happened (success or error) — a
  // not-connected probe must not report a phantom tool call.
  const toolsCalled =
    toolCallOk || toolErrors.length > 0
      ? [{ toolName: probeConfig.toolName, arguments: probeArguments }]
      : [];
  const transcript: IterationTranscript = {
    toolCalls: toolsCalled,
    ...(toolErrors.length > 0 ? { toolErrors } : {}),
    ...(observation
      ? { renderObservations: summarizeRenderObservations([observation]) }
      : {}),
  };
  const predicateResults = test.successPredicates?.length
    ? evaluatePredicates(transcript, test.successPredicates)
    : [];
  // With no authored checks, a probe still means "the widget renders":
  // clean tool call + rendered observation.
  const passed =
    !iterationError &&
    (test.successPredicates?.length
      ? allPredicatesPassed(predicateResults)
      : toolCallOk && observation?.status === "rendered");

  const evaluation: EvaluationResult = {
    expectedToolCalls: [],
    toolsCalled,
    missing: [],
    unexpected: [],
    argumentMismatches: [],
    passed,
  };

  const renderLatencyMs =
    observation?.status === "rendered" ? observation.elapsedMs : undefined;
  const outcomeSummary = iterationError
    ? `Probe failed: ${iterationError}`
    : !toolCallOk
      ? `Tool call failed: ${toolErrors[0]?.message ?? "unknown error"}`
      : observation?.status === "rendered"
        ? `Widget rendered in ${observation.elapsedMs}ms`
        : `Widget did not render (${observation?.status ?? "no observation"})`;
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: `Widget probe: ${probeConfig.toolName} on "${probeConfig.serverName}"`,
    },
    { role: "assistant", content: outcomeSummary },
  ];

  const finishParams = {
    iterationId,
    passed,
    toolsCalled,
    usage: {},
    messages,
    ...(observation ? { widgetRenderObservations: [observation] } : {}),
    status: iterationError ? ("failed" as const) : ("completed" as const),
    startedAt,
    ...(iterationError
      ? { error: iterationError }
      : !toolCallOk && toolErrors[0]?.message
        ? { error: toolErrors[0].message }
        : {}),
    resultSource: "reported" as const,
    metadata: {
      probe: true,
      ...(renderLatencyMs !== undefined ? { renderLatencyMs } : {}),
      ...(observation ? { renderStatus: observation.status } : {}),
      ...(predicateResults.length ? { predicates: predicateResults } : {}),
    },
  };

  try {
    if (recorder) {
      await recorder.finishIteration(finishParams);
    } else {
      await finalizeEvalIteration({ ...finishParams, convexClient });
    }
  } catch (error) {
    logger.error("[evals] failed to finalize probe iteration", error);
  }

  return { evaluation, iterationId: iterationId ?? undefined };
}
