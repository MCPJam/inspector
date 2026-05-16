import { ConvexHttpClient } from "convex/browser";
import type { MCPClientManager, MCPServerReplayConfig } from "@mcpjam/sdk";
import { z } from "zod";
import { generateTestCases } from "../../services/eval-agent";
import {
  convertToEvalTestCases,
  generateNegativeTestCases,
} from "../../services/negative-test-agent";
import { startSuiteRunWithRecorder } from "../../services/evals/recorder";
import {
  captureToolSnapshotForEvalAuthoring,
  storeReplayConfig,
} from "../../services/evals/route-helpers";
import {
  runEvalSuiteWithAiSdk,
  streamTestCase,
} from "../../services/evals-runner";
import type { EvalStreamEvent } from "@/shared/eval-stream-events";
import { logger } from "../../utils/logger";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import {
  resolveOrgModelConfig,
  type ResolvedOrgModelConfig,
} from "../../utils/org-model-config";
import { flattenServerToolSnapshotTools } from "../../utils/export-helpers.js";
import { sanitizeForConvexTransport } from "../../services/evals/convex-sanitize.js";
import { type PromptTurn } from "@/shared/prompt-turns";
import {
  matchOptionsSchema,
  resolveMatchOptions,
  type MatchOptionsDTO,
} from "@/shared/eval-matching";

const toolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    type: z.literal("tool"),
    toolName: z.string().min(1),
  }),
]);

const promptTurnSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  expectedToolCalls: z.array(
    z.object({
      toolName: z.string(),
      arguments: z.record(z.string(), z.any()),
    }),
  ),
  expectedOutput: z.string().optional(),
});

export const RunEvalsRequestSchema = z.object({
  projectId: z.string().optional(),
  suiteId: z.string().optional(),
  suiteName: z.string().optional(),
  suiteDescription: z.string().optional(),
  tests: z.array(
    z.object({
      title: z.string(),
      query: z.string(),
      runs: z.number().int().positive().max(10),
      model: z.string(),
      provider: z.string(),
      expectedToolCalls: z.array(
        z.object({
          toolName: z.string(),
          arguments: z.record(z.string(), z.any()),
        }),
      ),
      isNegativeTest: z.boolean().optional(),
      scenario: z.string().optional(),
      expectedOutput: z.string().optional(),
      promptTurns: z.array(promptTurnSchema).optional(),
      advancedConfig: z
        .object({
          system: z.string().optional(),
          temperature: z.number().optional(),
          toolChoice: toolChoiceSchema.optional(),
        })
        .passthrough()
        .optional(),
      matchOptions: matchOptionsSchema.optional(),
    }),
  ),
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  serverNames: z.array(z.string()).optional(),
  chatboxId: z.string().optional(),
  accessVersion: z.number().int().nonnegative().optional(),
  storageServerIds: z.array(z.string()).optional(),
  modelApiKeys: z.record(z.string(), z.string()).optional(),
  convexAuthToken: z.string(),
  notes: z.string().optional(),
  passCriteria: z
    .object({
      minimumPassRate: z.number(),
    })
    .optional(),
  /**
   * When true, the request is a rerun of an already-persisted suite — skip
   * the per-test-case upsert. Without this, derived wire fields (suite
   * default model substituted in for model-less cases, merged advancedConfig)
   * get baked into per-case overrides on first rerun, breaking later edits
   * to the suite default.
   */
  suiteRerun: z.boolean().optional(),
  /**
   * Transient per-run iteration count (1-10). Overlays `runs` on every
   * test case in the run snapshot without mutating the persisted
   * `EvalCase.runs` default. Cap-math counts this against
   * MAX_TOTAL_LLM_CALLS.
   */
  iterationOverride: z.number().int().min(1).max(10).optional(),
  /**
   * One-off match-option override for this run only. Resolved on top of
   * suite defaults + case overrides into each iteration's snapshot;
   * does NOT mutate persisted suite/case records.
   */
  matchOptionsOverride: matchOptionsSchema.optional(),
  /**
   * Scope this run to a single host attached to the suite. The Convex
   * `startTestSuiteRun` mutation snapshots the host's current config and
   * derives the run's server environment from it. When the suite has
   * multiple host attachments, the client makes one request per host.
   */
  namedHostId: z.string().optional(),
});

export type RunEvalsRequest = z.infer<typeof RunEvalsRequestSchema>;
type RunEvalsWithManagerRequest = RunEvalsRequest & {
  orgModelConfig?: ResolvedOrgModelConfig;
};

export const RunTestCaseRequestSchema = z.object({
  testCaseId: z.string(),
  model: z.string(),
  provider: z.string(),
  compareRunId: z.string().optional(),
  skipLastMessageRunUpdate: z.boolean().optional(),
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  chatboxId: z.string().optional(),
  accessVersion: z.number().int().nonnegative().optional(),
  modelApiKeys: z.record(z.string(), z.string()).optional(),
  convexAuthToken: z.string(),
  testCaseOverrides: z
    .object({
      query: z.string().optional(),
      expectedToolCalls: z.array(z.any()).optional(),
      isNegativeTest: z.boolean().optional(),
      runs: z.number().int().positive().max(10).optional(),
      expectedOutput: z.string().optional(),
      promptTurns: z.array(promptTurnSchema).optional(),
      advancedConfig: z
        .object({
          system: z.string().optional(),
          temperature: z.number().optional(),
          toolChoice: toolChoiceSchema.optional(),
        })
        .passthrough()
        .optional(),
      matchOptions: matchOptionsSchema.optional(),
    })
    .optional(),
  /**
   * One-off match-option override for this single-case run only. Does
   * NOT mutate the persisted case's `matchOptions`.
   */
  matchOptionsOverride: matchOptionsSchema.optional(),
  /**
   * One-off hostConfig override for this single-case run. Subset of
   * `HostConfigInputV2`; recorded on the iteration snapshot so the trace
   * shows which config the run actually used. Does NOT mutate the suite
   * hostConfig.
   */
  hostConfigOverride: z
    .object({
      hostStyle: z.string().optional(),
      hostContext: z.record(z.string(), z.unknown()).optional(),
      clientCapabilities: z.record(z.string(), z.unknown()).optional(),
      hostCapabilitiesOverride: z.record(z.string(), z.unknown()).optional(),
      chatUiOverride: z.record(z.string(), z.unknown()).optional(),
      mcpProfile: z.record(z.string(), z.unknown()).optional(),
      connectionDefaults: z
        .object({
          headers: z.record(z.string(), z.string()).optional(),
          requestTimeout: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type RunTestCaseRequest = z.infer<typeof RunTestCaseRequestSchema>;
type RunTestCaseWithManagerRequest = RunTestCaseRequest & {
  orgModelConfig?: ResolvedOrgModelConfig;
};

export const MAX_TOTAL_LLM_CALLS = 300;

export function assertSuiteRunWithinCap(
  request: RunEvalsRequest,
  configCount = 1,
) {
  const override = request.iterationOverride;
  // Each iteration issues one model call per prompt turn; counting only `runs`
  // lets a multi-turn save-from-chat case bypass the cap.
  const totalCalls =
    request.tests.reduce((sum, t) => {
      const iterations = override ?? t.runs ?? 0;
      const turns = Math.max(t.promptTurns?.length ?? 0, 1);
      return sum + iterations * turns;
    }, 0) * Math.max(configCount, 1);
  if (totalCalls > MAX_TOTAL_LLM_CALLS) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Suite run would issue ${totalCalls} LLM calls, above the cap of ${MAX_TOTAL_LLM_CALLS}. Reduce iterations or test count.`,
      { totalCalls, cap: MAX_TOTAL_LLM_CALLS },
    );
  }
}

/**
 * Counts override prompt-turns when present, then falls back to the
 * persisted case's prompt-turns count. Callers that have already loaded
 * the persisted test case should pass it via `resolved` — without it, a
 * multi-turn saved case can slip past the cap because we'd count it as a
 * single-turn run.
 */
export function assertTestCaseRunWithinCap(
  request: RunTestCaseRequest,
  configCount = 1,
  resolved?: { promptTurnsLength?: number },
) {
  const iterations = request.testCaseOverrides?.runs ?? 1;
  const overrideTurns = request.testCaseOverrides?.promptTurns?.length;
  const resolvedTurns = resolved?.promptTurnsLength;
  const turns = Math.max(overrideTurns ?? resolvedTurns ?? 0, 1);
  const totalCalls = iterations * turns * Math.max(configCount, 1);
  if (totalCalls > MAX_TOTAL_LLM_CALLS) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Test case run would issue ${totalCalls} LLM calls, above the cap of ${MAX_TOTAL_LLM_CALLS}.`,
      { totalCalls, cap: MAX_TOTAL_LLM_CALLS },
    );
  }
}

export const GenerateTestsRequestSchema = z.object({
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  convexAuthToken: z.string(),
});

export type GenerateTestsRequest = z.infer<typeof GenerateTestsRequestSchema>;

export const GenerateNegativeTestsRequestSchema = z.object({
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  convexAuthToken: z.string(),
});

export type GenerateNegativeTestsRequest = z.infer<
  typeof GenerateNegativeTestsRequestSchema
>;

/**
 * Best-effort fetch of a suite's `defaultMatchOptions` so single-case
 * runs resolve the same suite → case → override precedence chain that
 * `precreateIterationsForRun` applies for suite-level runs.
 * Returns undefined on any error; defaults still apply downstream.
 */
async function loadSuiteDefaultMatchOptions(
  convexClient: ConvexHttpClient,
  suiteId?: string,
): Promise<MatchOptionsDTO | undefined> {
  if (!suiteId) return undefined;
  try {
    const suite = await convexClient.query("testSuites:getTestSuite" as any, {
      suiteId,
    });
    return (suite?.defaultMatchOptions as MatchOptionsDTO | undefined) ??
      undefined;
  } catch {
    return undefined;
  }
}

function createConvexClients(convexAuthToken: string) {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL is not set");
  }

  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }

  const convexClient = new ConvexHttpClient(convexUrl);
  convexClient.setAuth(convexAuthToken);

  return { convexClient, convexHttpUrl };
}

export function resolveServerIdsOrThrow(
  requestedIds: string[],
  clientManager: MCPClientManager,
): string[] {
  const available = clientManager.listServers();
  const resolved: string[] = [];

  for (const requestedId of requestedIds) {
    const match =
      available.find((id) => id === requestedId) ??
      available.find((id) => id.toLowerCase() === requestedId.toLowerCase());

    if (!match) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        `Server '${requestedId}' not found`,
      );
    }

    if (!resolved.includes(match)) {
      resolved.push(match);
    }
  }

  return resolved;
}

function normalizeForComparison(obj: any): any {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(normalizeForComparison);

  const sorted: Record<string, unknown> = {};
  Object.keys(obj)
    .sort()
    .forEach((key) => {
      sorted[key] = normalizeForComparison(obj[key]);
    });
  return sorted;
}

export function filterAndRemapReplayConfigs(
  replayConfigs: MCPServerReplayConfig[],
  resolvedServerIds: string[],
  persistedServerIds: string[],
): MCPServerReplayConfig[] {
  const persistedIdByResolvedId = new Map<string, string>();

  for (const [index, resolvedServerId] of resolvedServerIds.entries()) {
    const persistedServerId = persistedServerIds[index] ?? resolvedServerId;
    if (!resolvedServerId || !persistedServerId) {
      continue;
    }
    persistedIdByResolvedId.set(resolvedServerId, persistedServerId);
  }

  return replayConfigs.flatMap((config) => {
    const persistedServerId = persistedIdByResolvedId.get(config.serverId);
    if (!persistedServerId) {
      return [];
    }

    return [
      {
        ...config,
        serverId: persistedServerId,
      },
    ];
  });
}

function buildPersistedSuiteEnvironment(args: {
  resolvedServerIds: string[];
  persistedServerRefs: string[];
  serverNames?: string[];
}) {
  const serverNames =
    args.serverNames &&
    args.serverNames.length > 0 &&
    args.serverNames.length === args.resolvedServerIds.length
      ? args.serverNames
      : args.persistedServerRefs;

  const serverBindings =
    args.serverNames &&
    args.serverNames.length > 0 &&
    args.serverNames.length === args.resolvedServerIds.length
      ? args.serverNames.map((serverName, index) => ({
          serverName,
          projectServerId: args.resolvedServerIds[index],
        }))
      : undefined;

  return {
    servers: serverNames,
    ...(serverBindings ? { serverBindings } : {}),
  };
}

export async function runEvalsWithManager(
  clientManager: MCPClientManager,
  request: RunEvalsWithManagerRequest,
) {
  const {
    suiteId,
    projectId,
    suiteName,
    suiteDescription,
    tests,
    serverIds,
    serverNames,
    chatboxId,
    accessVersion,
    storageServerIds,
    modelApiKeys,
    orgModelConfig,
    convexAuthToken,
    notes,
    passCriteria,
    suiteRerun,
    iterationOverride,
    matchOptionsOverride,
    namedHostId,
  } = request;

  if (!suiteId && (!suiteName || suiteName.trim().length === 0)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Provide suiteId or suiteName",
    );
  }
  if (!suiteId && !projectId) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "projectId is required when creating a new eval suite",
    );
  }

  assertSuiteRunWithinCap(request);

  const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);
  const persistedServerRefs =
    storageServerIds && storageServerIds.length > 0
      ? storageServerIds
      : resolvedServerIds;
  const persistedEnvironment = buildPersistedSuiteEnvironment({
    resolvedServerIds,
    persistedServerRefs,
    serverNames,
  });
  const { convexClient, convexHttpUrl } = createConvexClients(convexAuthToken);
  const { toolSnapshot, toolSnapshotDebug } =
    await captureToolSnapshotForEvalAuthoring(
      clientManager,
      resolvedServerIds,
      {
        logPrefix: "evals",
      },
    );

  let resolvedSuiteId = suiteId ?? null;

  const testCaseMap = new Map<
    string,
    {
      title: string;
      query: string;
      runs: number;
      models: Array<{ model: string; provider: string }>;
      expectedToolCalls: any[];
      isNegativeTest?: boolean;
      scenario?: string;
      expectedOutput?: string;
      promptTurns?: PromptTurn[];
      judgeRequirement?: string;
      advancedConfig?: any;
      matchOptions?: import("@/shared/eval-matching").MatchOptionsDTO;
    }
  >();

  for (const test of tests) {
    const key = `${test.title}-${test.query}`;
    if (!testCaseMap.has(key)) {
      testCaseMap.set(key, {
        title: test.title,
        query: test.query,
        runs: test.runs,
        models: [],
        expectedToolCalls: test.expectedToolCalls,
        isNegativeTest: test.isNegativeTest,
        scenario: test.scenario,
        expectedOutput: test.expectedOutput,
        promptTurns: test.promptTurns,
        advancedConfig: test.advancedConfig,
        matchOptions: test.matchOptions,
      });
    }
    testCaseMap.get(key)!.models.push({
      model: test.model,
      provider: test.provider,
    });
  }

  if (resolvedSuiteId) {
    await convexClient.mutation("testSuites:updateTestSuite" as any, {
      suiteId: resolvedSuiteId,
      name: suiteName,
      description: suiteDescription,
      environment: persistedEnvironment,
    });

    // On a suite rerun, do NOT upsert per-case fields. The wire payload
    // contains values derived from suite.defaultConfig (model substituted in
    // for model-less cases, etc.); writing them back would bake the current
    // suite default into per-case overrides and stop later default changes
    // from propagating. Cases are already persisted; rerun just runs them.
    if (suiteRerun) {
      // skip upsert
    } else {
    const existingTestCases = await convexClient.query(
      "testSuites:listTestCases" as any,
      { suiteId: resolvedSuiteId },
    );

    for (const [, testCaseData] of testCaseMap.entries()) {
      const existingTestCase = existingTestCases?.find(
        (tc: any) =>
          tc.title === testCaseData.title && tc.query === testCaseData.query,
      );

      if (existingTestCase) {
        const normalize = (val: any) =>
          val === undefined || val === null ? null : val;

        const modelsChanged =
          JSON.stringify(
            normalizeForComparison(existingTestCase.models || []),
          ) !==
          JSON.stringify(normalizeForComparison(testCaseData.models || []));
        const runsChanged =
          normalize(existingTestCase.runs) !== normalize(testCaseData.runs);
        const expectedToolCallsChanged =
          JSON.stringify(
            normalizeForComparison(existingTestCase.expectedToolCalls || []),
          ) !==
          JSON.stringify(
            normalizeForComparison(testCaseData.expectedToolCalls || []),
          );
        const isNegativeTestChanged =
          normalize(existingTestCase.isNegativeTest) !==
          normalize(testCaseData.isNegativeTest);
        const scenarioChanged =
          normalize(existingTestCase.scenario) !==
          normalize(testCaseData.scenario);
        const expectedOutputChanged =
          normalize(existingTestCase.expectedOutput) !==
          normalize(testCaseData.expectedOutput);
        const promptTurnsChanged =
          JSON.stringify(
            normalizeForComparison(existingTestCase.promptTurns || []),
          ) !==
          JSON.stringify(
            normalizeForComparison(testCaseData.promptTurns || []),
          );
        const judgeRequirementChanged =
          normalize(existingTestCase.judgeRequirement) !==
          normalize(testCaseData.judgeRequirement);
        const advancedConfigChanged =
          JSON.stringify(
            normalizeForComparison(existingTestCase.advancedConfig),
          ) !==
          JSON.stringify(normalizeForComparison(testCaseData.advancedConfig));
        const matchOptionsChanged =
          JSON.stringify(
            normalizeForComparison(existingTestCase.matchOptions),
          ) !==
          JSON.stringify(normalizeForComparison(testCaseData.matchOptions));

        const hasChanges =
          modelsChanged ||
          runsChanged ||
          expectedToolCallsChanged ||
          isNegativeTestChanged ||
          scenarioChanged ||
          expectedOutputChanged ||
          promptTurnsChanged ||
          judgeRequirementChanged ||
          advancedConfigChanged ||
          matchOptionsChanged;

        if (hasChanges) {
          await convexClient.mutation("testSuites:updateTestCase" as any, {
            testCaseId: existingTestCase._id,
            models: testCaseData.models,
            runs: testCaseData.runs,
            expectedToolCalls: sanitizeForConvexTransport(
              testCaseData.expectedToolCalls,
            ),
            isNegativeTest: testCaseData.isNegativeTest,
            scenario: testCaseData.scenario,
            expectedOutput: testCaseData.expectedOutput,
            promptTurns: sanitizeForConvexTransport(testCaseData.promptTurns),
            advancedConfig: sanitizeForConvexTransport(
              testCaseData.advancedConfig,
            ),
            matchOptions: testCaseData.matchOptions,
          });
        }
      } else {
        await convexClient.mutation("testSuites:createTestCase" as any, {
          suiteId: resolvedSuiteId,
          title: testCaseData.title,
          query: testCaseData.query,
          models: testCaseData.models,
          runs: testCaseData.runs,
          expectedToolCalls: sanitizeForConvexTransport(
            testCaseData.expectedToolCalls,
          ),
          isNegativeTest: testCaseData.isNegativeTest,
          scenario: testCaseData.scenario,
          expectedOutput: testCaseData.expectedOutput,
          promptTurns: sanitizeForConvexTransport(testCaseData.promptTurns),
          judgeRequirement: testCaseData.judgeRequirement,
          advancedConfig: sanitizeForConvexTransport(
            testCaseData.advancedConfig,
          ),
          matchOptions: testCaseData.matchOptions,
        });
      }
    }
    }
  } else {
    const createdSuite = await convexClient.mutation(
      "testSuites:createTestSuite" as any,
      {
        projectId,
        name: suiteName!,
        description: suiteDescription,
        environment: persistedEnvironment,
        defaultPassCriteria: passCriteria,
      },
    );

    if (!createdSuite?._id) {
      throw new Error("Failed to create suite");
    }

    resolvedSuiteId = createdSuite._id as string;

    for (const [, testCaseData] of testCaseMap.entries()) {
      await convexClient.mutation("testSuites:createTestCase" as any, {
        suiteId: resolvedSuiteId,
        title: testCaseData.title,
        query: testCaseData.query,
        models: testCaseData.models,
        runs: testCaseData.runs,
        expectedToolCalls: sanitizeForConvexTransport(
          testCaseData.expectedToolCalls,
        ),
        isNegativeTest: testCaseData.isNegativeTest,
        scenario: testCaseData.scenario,
        expectedOutput: testCaseData.expectedOutput,
        promptTurns: sanitizeForConvexTransport(testCaseData.promptTurns),
        judgeRequirement: testCaseData.judgeRequirement,
        advancedConfig: sanitizeForConvexTransport(testCaseData.advancedConfig),
        matchOptions: testCaseData.matchOptions,
      });
    }
  }

  const { runId, config, recorder } = await startSuiteRunWithRecorder({
    convexClient,
    suiteId: resolvedSuiteId,
    notes,
    passCriteria,
    serverIds: resolvedServerIds,
    toolSnapshot,
    toolSnapshotDebug,
    iterationOverride,
    matchOptionsOverride,
    namedHostId,
  });

  const replayConfigsToStore = filterAndRemapReplayConfigs(
    clientManager.getServerReplayConfigs(),
    resolvedServerIds,
    persistedServerRefs,
  );
  if (replayConfigsToStore.length > 0) {
    try {
      await storeReplayConfig(runId, replayConfigsToStore, convexAuthToken);
    } catch (error) {
      logger.warn("[evals] Failed to store replay config for suite run", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Resolve org model config: prefer client-sent keys, fall back to org config.
  // Treat an empty client-provided map as "no keys" so org fallback still runs.
  // For reruns, projectId may not be in the request — derive it from the
  // suite record so org BYOK keeps working.
  const hasClientKeys =
    !!modelApiKeys && Object.keys(modelApiKeys).length > 0;
  const resolvedModelApiKeys = hasClientKeys ? modelApiKeys : undefined;
  let resolvedOrgModelConfig = orgModelConfig;
  if (!resolvedModelApiKeys && !resolvedOrgModelConfig) {
    let projectIdForOrgConfig: string | undefined = projectId;
    let legacyWorkspaceIdForOrgConfig: string | undefined;
    if (!projectIdForOrgConfig && resolvedSuiteId) {
      try {
        const suite = await convexClient.query(
          "testSuites:getTestSuite" as any,
          { suiteId: resolvedSuiteId },
        );
        if (suite?.projectId) {
          projectIdForOrgConfig = String(suite.projectId);
        } else if (suite?.workspaceId) {
          legacyWorkspaceIdForOrgConfig = String(suite.workspaceId);
        }
      } catch (error) {
        logger.warn("[evals] Failed to load suite for projectId fallback", {
          suiteId: resolvedSuiteId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const orgConfigTarget = projectIdForOrgConfig
      ? { projectId: projectIdForOrgConfig }
      : legacyWorkspaceIdForOrgConfig
      ? { workspaceId: legacyWorkspaceIdForOrgConfig }
      : undefined;
    if (orgConfigTarget) {
      try {
        const orgConfig = await resolveOrgModelConfig(orgConfigTarget, {
          bearerToken: convexAuthToken,
          chatboxId,
          accessVersion,
          serverIds: resolvedServerIds,
        });
        resolvedOrgModelConfig = orgConfig;
      } catch (error) {
        logger.warn("[evals] Failed to resolve org model config", {
          projectId: projectIdForOrgConfig,
          legacyWorkspaceId: legacyWorkspaceIdForOrgConfig,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await runEvalSuiteWithAiSdk({
    suiteId: resolvedSuiteId,
    runId,
    config,
    modelApiKeys: resolvedModelApiKeys ?? undefined,
    orgModelConfig: resolvedOrgModelConfig,
    convexClient,
    convexHttpUrl,
    convexAuthToken,
    mcpClientManager: clientManager,
    recorder,
  });

  return {
    success: true,
    suiteId: resolvedSuiteId,
    runId,
    message: "Evals completed successfully. Check the Evals tab for results.",
  };
}

export type RunEvalTestCaseWithManagerOptions = {
  /** When true, skip mutating `testCase.lastMessageRun` after the run (safe for parallel quick runs on the same case). */
  skipLastMessageRunUpdate?: boolean;
};

export async function runEvalTestCaseWithManager(
  clientManager: MCPClientManager,
  request: RunTestCaseWithManagerRequest,
  options?: RunEvalTestCaseWithManagerOptions,
) {
  const {
    testCaseId,
    model,
    provider,
    compareRunId,
    serverIds,
    chatboxId,
    accessVersion,
    skipLastMessageRunUpdate,
    modelApiKeys,
    orgModelConfig,
    convexAuthToken,
    testCaseOverrides,
    matchOptionsOverride,
    hostConfigOverride,
  } = request;
  // TODO(host-config-override): persist `hostConfigOverride` on the
  // iteration's `testCaseSnapshot` so the trace records which hostConfig
  // the run actually used. Blocked on extending the
  // `testIteration.testCaseSnapshot` validator in
  // `mcpjam-backend/convex/schema.ts:655` to allow a
  // `hostConfigOverride: v.optional(v.any())` field. Until that lands,
  // the override is accepted at the API boundary (validated by zod) but
  // has no runtime / persistence effect. Same gap exists for the suite's
  // own hostConfig; both will be plumbed into the iteration snapshot +
  // LLM run in a follow-up.
  void hostConfigOverride;

  const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);
  const { convexClient, convexHttpUrl } = createConvexClients(convexAuthToken);

  const testCase = await convexClient.query("testSuites:getTestCase" as any, {
    testCaseId,
  });

  if (!testCase) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Test case not found");
  }

  assertTestCaseRunWithinCap(request, 1, {
    promptTurnsLength: testCase.promptTurns?.length,
  });

  const suiteDefaultMatchOptions = await loadSuiteDefaultMatchOptions(
    convexClient,
    testCase.evalTestSuiteId,
  );
  const test = {
    title: testCase.title,
    query: testCaseOverrides?.query ?? testCase.query,
    runs: testCaseOverrides?.runs ?? 1,
    model,
    provider,
    expectedToolCalls:
      testCaseOverrides?.expectedToolCalls ?? testCase.expectedToolCalls ?? [],
    isNegativeTest:
      testCaseOverrides?.isNegativeTest ?? testCase.isNegativeTest,
    expectedOutput:
      testCaseOverrides?.expectedOutput ?? testCase.expectedOutput,
    promptTurns:
      (testCaseOverrides?.promptTurns as PromptTurn[] | undefined) ??
      testCase.promptTurns,
    advancedConfig:
      testCaseOverrides?.advancedConfig ?? testCase.advancedConfig,
    matchOptions: resolveMatchOptions(
      suiteDefaultMatchOptions,
      (testCaseOverrides?.matchOptions ?? testCase.matchOptions) as
        | MatchOptionsDTO
        | undefined,
      matchOptionsOverride,
    ),
    testCaseId: testCase._id,
  };

  // Resolve org model config: prefer client-sent keys, fall back to org config.
  // Treat an empty client-provided map as "no keys".
  const hasClientKeysForCase =
    !!modelApiKeys && Object.keys(modelApiKeys).length > 0;
  const resolvedModelApiKeys = hasClientKeysForCase ? modelApiKeys : undefined;
  let resolvedOrgModelConfig = orgModelConfig;
  const testCaseProjectId =
    typeof testCase.projectId === "string" ? testCase.projectId : undefined;
  const testCaseLegacyWorkspaceId =
    !testCaseProjectId && typeof testCase.workspaceId === "string"
      ? testCase.workspaceId
      : undefined;
  const testCaseOrgConfigTarget = testCaseProjectId
    ? { projectId: testCaseProjectId }
    : testCaseLegacyWorkspaceId
    ? { workspaceId: testCaseLegacyWorkspaceId }
    : undefined;
  if (
    !resolvedModelApiKeys &&
    !resolvedOrgModelConfig &&
    testCaseOrgConfigTarget
  ) {
    try {
      resolvedOrgModelConfig = await resolveOrgModelConfig(
        testCaseOrgConfigTarget,
        {
          bearerToken: convexAuthToken,
          chatboxId,
          accessVersion,
          serverIds: resolvedServerIds,
        },
      );
    } catch (error) {
      logger.warn("[evals] Failed to resolve org model config for test case", {
        testCaseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const quickResult = await runEvalSuiteWithAiSdk({
    suiteId: testCase.evalTestSuiteId,
    runId: null,
    config: {
      tests: [test],
      environment: { servers: resolvedServerIds },
    },
    modelApiKeys: resolvedModelApiKeys ?? undefined,
    orgModelConfig: resolvedOrgModelConfig,
    convexClient,
    convexHttpUrl,
    convexAuthToken,
    mcpClientManager: clientManager,
    recorder: null,
    testCaseId,
    compareRunId,
  });

  const expectedIterationId =
    quickResult?.quickRunIterationOutcomes?.[0]?.iterationId;

  let latestIteration: unknown = null;
  if (expectedIterationId) {
    latestIteration = await convexClient.query(
      "testSuites:getTestIteration" as any,
      { iterationId: expectedIterationId },
    );
  }
  if (!latestIteration) {
    const recentIterations = await convexClient.query(
      "testSuites:listTestIterations" as any,
      { testCaseId },
    );
    latestIteration = recentIterations?.[0] || null;
  }

  if (
    !options?.skipLastMessageRunUpdate &&
    !skipLastMessageRunUpdate &&
    (latestIteration as any)?._id
  ) {
    await convexClient.mutation("testSuites:updateTestCase" as any, {
      testCaseId,
      lastMessageRun: (latestIteration as any)._id,
    });
  }

  return {
    success: true,
    message: "Test case completed successfully",
    iteration: latestIteration,
  };
}

export async function generateEvalTestsWithManager(
  clientManager: MCPClientManager,
  request: GenerateTestsRequest,
) {
  const resolvedServerIds = resolveServerIdsOrThrow(
    request.serverIds,
    clientManager,
  );
  const { toolSnapshot } = await captureToolSnapshotForEvalAuthoring(
    clientManager,
    resolvedServerIds,
    {
      logPrefix: "evals.generate-tests",
    },
  );
  const filteredTools = flattenServerToolSnapshotTools(toolSnapshot);

  if (filteredTools.length === 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "No tools found for selected servers",
    );
  }

  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }

  const tests = await generateTestCases(
    toolSnapshot,
    convexHttpUrl,
    request.convexAuthToken,
  );

  return {
    success: true,
    tests,
  };
}

export async function generateNegativeEvalTestsWithManager(
  clientManager: MCPClientManager,
  request: GenerateNegativeTestsRequest,
) {
  const resolvedServerIds = resolveServerIdsOrThrow(
    request.serverIds,
    clientManager,
  );
  const { toolSnapshot } = await captureToolSnapshotForEvalAuthoring(
    clientManager,
    resolvedServerIds,
    {
      logPrefix: "evals.generate-negative-tests",
    },
  );
  const filteredTools = flattenServerToolSnapshotTools(toolSnapshot);

  if (filteredTools.length === 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "No tools found for selected servers",
    );
  }

  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }

  const tests = await generateNegativeTestCases(
    toolSnapshot,
    convexHttpUrl,
    request.convexAuthToken,
  );

  return {
    success: true,
    tests,
    evalTests: convertToEvalTestCases(tests),
  };
}

export async function streamEvalTestCaseWithManager(
  clientManager: MCPClientManager,
  request: RunTestCaseWithManagerRequest,
  options?: {
    skipLastMessageRunUpdate?: boolean;
    onStreamComplete?: () => void;
  },
): Promise<ReadableStream<Uint8Array>> {
  const {
    testCaseId,
    model,
    provider,
    compareRunId,
    serverIds,
    chatboxId,
    accessVersion,
    skipLastMessageRunUpdate,
    modelApiKeys,
    orgModelConfig,
    convexAuthToken,
    testCaseOverrides,
    matchOptionsOverride,
    hostConfigOverride,
  } = request;
  // TODO(host-config-override): persist `hostConfigOverride` on the
  // iteration's `testCaseSnapshot` so the trace records which hostConfig
  // the run actually used. Blocked on extending the
  // `testIteration.testCaseSnapshot` validator in
  // `mcpjam-backend/convex/schema.ts:655` to allow a
  // `hostConfigOverride: v.optional(v.any())` field. Until that lands,
  // the override is accepted at the API boundary (validated by zod) but
  // has no runtime / persistence effect. Same gap exists for the suite's
  // own hostConfig; both will be plumbed into the iteration snapshot +
  // LLM run in a follow-up.
  void hostConfigOverride;

  const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);
  const { convexClient, convexHttpUrl } = createConvexClients(convexAuthToken);

  const testCase = await convexClient.query("testSuites:getTestCase" as any, {
    testCaseId,
  });

  if (!testCase) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Test case not found");
  }

  assertTestCaseRunWithinCap(request, 1, {
    promptTurnsLength: testCase.promptTurns?.length,
  });

  const suiteDefaultMatchOptions = await loadSuiteDefaultMatchOptions(
    convexClient,
    testCase.evalTestSuiteId,
  );
  const test = {
    title: testCase.title,
    query: testCaseOverrides?.query ?? testCase.query,
    runs: testCaseOverrides?.runs ?? 1,
    model,
    provider,
    expectedToolCalls:
      testCaseOverrides?.expectedToolCalls ?? testCase.expectedToolCalls ?? [],
    isNegativeTest:
      testCaseOverrides?.isNegativeTest ?? testCase.isNegativeTest,
    expectedOutput:
      testCaseOverrides?.expectedOutput ?? testCase.expectedOutput,
    promptTurns:
      (testCaseOverrides?.promptTurns as PromptTurn[] | undefined) ??
      testCase.promptTurns,
    advancedConfig:
      testCaseOverrides?.advancedConfig ?? testCase.advancedConfig,
    matchOptions: resolveMatchOptions(
      suiteDefaultMatchOptions,
      (testCaseOverrides?.matchOptions ?? testCase.matchOptions) as
        | MatchOptionsDTO
        | undefined,
      matchOptionsOverride,
    ),
    testCaseId: testCase._id,
  };

  // Resolve org model config: prefer client-sent keys, fall back to org config.
  // Treat an empty client-provided map as "no keys".
  const hasClientStreamKeys =
    !!modelApiKeys && Object.keys(modelApiKeys).length > 0;
  const resolvedStreamModelApiKeys = hasClientStreamKeys
    ? modelApiKeys
    : undefined;
  let resolvedStreamOrgModelConfig = orgModelConfig;
  const streamTestCaseProjectId =
    typeof testCase.projectId === "string" ? testCase.projectId : undefined;
  const streamTestCaseLegacyWorkspaceId =
    !streamTestCaseProjectId && typeof testCase.workspaceId === "string"
      ? testCase.workspaceId
      : undefined;
  const streamTestCaseOrgConfigTarget = streamTestCaseProjectId
    ? { projectId: streamTestCaseProjectId }
    : streamTestCaseLegacyWorkspaceId
    ? { workspaceId: streamTestCaseLegacyWorkspaceId }
    : undefined;
  if (
    !resolvedStreamModelApiKeys &&
    !resolvedStreamOrgModelConfig &&
    streamTestCaseOrgConfigTarget
  ) {
    try {
      resolvedStreamOrgModelConfig = await resolveOrgModelConfig(
        streamTestCaseOrgConfigTarget,
        {
          bearerToken: convexAuthToken,
          chatboxId,
          accessVersion,
          serverIds: resolvedServerIds,
        },
      );
    } catch (error) {
      logger.warn(
        "[evals] Failed to resolve org model config for stream test case",
        {
          testCaseId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  const tools = (await clientManager.getToolsForAiSdk(
    resolvedServerIds,
  )) as Record<string, any>;
  const encoder = new TextEncoder();

  const sseEncode = (event: EvalStreamEvent): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const outcomes = await streamTestCase({
          test,
          tools,
          mcpClientManager: clientManager,
          recorder: null,
          modelApiKeys: resolvedStreamModelApiKeys ?? undefined,
          orgModelConfig: resolvedStreamOrgModelConfig,
          convexHttpUrl,
          convexAuthToken,
          convexClient,
          testCaseId,
          suiteId: testCase.evalTestSuiteId,
          runId: null,
          compareRunId,
          emit: (event: EvalStreamEvent) => {
            try {
              controller.enqueue(sseEncode(event));
            } catch {
              // controller may be closed
            }
          },
        });

        // Retrieve the iteration
        const expectedIterationId = outcomes[0]?.iterationId;
        let latestIteration: unknown = null;
        if (expectedIterationId) {
          latestIteration = await convexClient.query(
            "testSuites:getTestIteration" as any,
            { iterationId: expectedIterationId },
          );
        }
        if (!latestIteration) {
          const recentIterations = await convexClient.query(
            "testSuites:listTestIterations" as any,
            { testCaseId },
          );
          latestIteration = recentIterations?.[0] || null;
        }

        // Update lastMessageRun
        if (
          !options?.skipLastMessageRunUpdate &&
          !skipLastMessageRunUpdate &&
          (latestIteration as any)?._id
        ) {
          await convexClient.mutation("testSuites:updateTestCase" as any, {
            testCaseId,
            lastMessageRun: (latestIteration as any)._id,
          });
        }

        // Emit complete event
        controller.enqueue(
          sseEncode({
            type: "complete",
            iterationId: expectedIterationId,
            iteration: latestIteration,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(
          sseEncode({
            type: "error",
            message,
            details:
              error instanceof WebRouteError && error.details
                ? JSON.stringify(error.details)
                : undefined,
          }),
        );
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
        options?.onStreamComplete?.();
      }
    },
  });
}
