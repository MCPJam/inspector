// Imports the built package the way a consumer does and checks that each public
// export is present. Run from a file because the inline `node -e` form was
// longer than cmd.exe allows (8,191 characters), so it failed on Windows.
const root = await import("@mcpjam/sdk");
for (const n of [
  "driveTaskToTerminal",
  "TaskLifecycleEngine",
  "taskLifecycleKey",
  "isTerminalLifecycleStatus",
  "extensionTaskToObservation",
  "legacyTaskToObservation",
  "isUnknownTaskError",
  "canDeclareTasksExtension",
  "readDeclaredInputCapabilities",
  "TaskInputRejectedError",
  "createStrictElicitationContentValidator",
  "retryAfterMsFromError",
]) {
  if (typeof root[n] !== "function") {
    throw new Error("missing tasks export: " + n);
  }
}
for (const n of [
  "loadEvalSuiteFile",
  "resolveEvalSuiteFile",
  "serializeEvalSuiteFile",
  "formatSuiteFileFindings",
  "suiteFilePointer",
]) {
  if (typeof root[n] !== "function") {
    throw new Error("missing suite-file export: " + n);
  }
}
for (const n of [
  "releaseMcpjamModelLeases",
  "McpjamLeaseClient",
  "McpjamLeaseError",
]) {
  if (typeof root[n] !== "function") {
    throw new Error("missing mcpjam-lease export: " + n);
  }
}
for (const n of [
  "runSuiteFile",
  "createSuiteFileRunner",
  "SuiteFileRunError",
  "isSuiteFileRunError",
  "formatLocalEvalRunSummary",
  "isLocalEvalRunReport",
  "platformCaseFromSuiteFileCase",
  "suiteFileSourceHash",
]) {
  if (typeof root[n] !== "function") {
    throw new Error("missing suite-file runner export: " + n);
  }
}
if (root.LOCAL_EVAL_RUN_REPORT_KIND !== "eval-local-run") {
  throw new Error("the local run report kind moved");
}
const browserEntry = await import("@mcpjam/sdk/browser");
if ("runSuiteFile" in browserEntry) {
  throw new Error("runSuiteFile leaked into the browser entry");
}
for (const n of [
  "gradingPolicyFromLoadedSuiteFile",
  "gradingPolicyFromPlatformSuiteSettings",
  "planPlatformSuiteGradingUpdate",
  "gradingPolicyForReportedRun",
]) {
  if (typeof root[n] !== "function") {
    throw new Error("missing grading-policy export: " + n);
  }
}
for (const n of [
  "TERMINAL_LIFECYCLE_STATUSES",
  "UNKNOWN_TASK_ERROR_CODE",
  "DEFAULT_TASK_INPUT_LIMITS",
]) {
  if (root[n] === undefined) {
    throw new Error("missing tasks export: " + n);
  }
}
for (const n of [
  "MAX_SUITE_FILE_BYTES",
  "SUITE_FILE_VALIDITY_DEFAULTS",
  "SUITE_FILE_DEFAULT_CAPTURE_LEVEL",
  "SUITE_FILE_FINDING_CODES",
]) {
  if (root[n] === undefined) {
    throw new Error("missing suite-file export: " + n);
  }
}
if (root.MAX_SUITE_FILE_BYTES !== 1048576) {
  throw new Error("MAX_SUITE_FILE_BYTES is not the pinned 1 MiB cap");
}
for (const n of [
  "GRADING_POLICY_READ_REFUSALS",
  "DEFAULT_SUITE_WIDE_THRESHOLD_PERCENT",
  "LEGACY_SUITE_WIDE_THRESHOLD_PERCENT",
]) {
  if (root[n] === undefined) {
    throw new Error("missing grading-policy export: " + n);
  }
}
if (root.DEFAULT_SUITE_WIDE_THRESHOLD_PERCENT !== 70) {
  throw new Error(
    "the suite-wide default threshold is not the documented 70 percent"
  );
}
if (
  !root.GRADING_POLICY_READ_REFUSALS.includes("deploymentDoesNotReportPolicy")
) {
  throw new Error(
    "the capability refusal for a deployment that cannot name the policy is gone"
  );
}
await import("@mcpjam/sdk/browser");
await import("@mcpjam/sdk/worker");
await import("@mcpjam/sdk/operations");
await import("@mcpjam/sdk/skill-reference");
await import("@mcpjam/sdk/model-factory");
await import("@mcpjam/sdk/matchers");
const predicatesSubpath = await import("@mcpjam/sdk/predicates");
const assertionsSubpath = await import("@mcpjam/sdk/assertions");
for (const n of ["evaluatePredicates", "stripCheckPolicy"]) {
  if (typeof predicatesSubpath[n] !== "function") {
    throw new Error("missing predicates export: " + n);
  }
}
for (const n of [
  "evaluateAssertion",
  "evaluateAssertions",
  "allAssertionsPassed",
  "stripAssertionPolicy",
  "assertionRole",
  "requiresRenderObservations",
]) {
  if (typeof assertionsSubpath[n] !== "function") {
    throw new Error("missing assertions export: " + n);
  }
}
for (const n of [
  "assertionSchema",
  "assertionUnion",
  "ASSERTION_POLICY_KEYS",
]) {
  if (assertionsSubpath[n] === undefined) {
    throw new Error("missing assertions export: " + n);
  }
}
for (const n of ["assertion", "judge", "runEvaluators"]) {
  if (typeof root[n] !== "function") {
    throw new Error("missing evaluator runtime export: " + n);
  }
}
const contract = await import("@mcpjam/sdk/contract");
for (const n of [
  "canonicalJson",
  "canonicalDigest",
  "sha256Hex",
  "resolveScoreDefinition",
  "definitionHash",
  "evaluationConfigHash",
  "buildEvaluationConfigSnapshot",
  "aggregateEvaluationConfigHash",
  "allGatingScorersPassed",
  "scorePassed",
  "finalizeScoreResult",
  "errorScoreResult",
  "skippedScoreResult",
  "notApplicableScoreResult",
  "predicateScoreDefinition",
  "scoreResultFromPredicateResult",
  "toolMatchScoreDefinition",
  "fromToolMatchResult",
  "legacyTestScoreDefinition",
  "fromLegacyTestOutcome",
  "fromGoalCompletionCase",
  "fromCriterionResult",
  "generatedPredicateScorerId",
  "toEvaluatorResult",
  "fromEvaluatorResult",
  "finalizeEvaluatorResult",
  "errorEvaluatorResult",
  "skippedEvaluatorResult",
  "notApplicableEvaluatorResult",
  "toScoreRawOutcome",
  "resolveEvaluatorDefinition",
  "evaluatorDefinitionHash",
  "allGatingEvaluatorsPassed",
  "evaluatorKindOf",
  "isSelectionStageAssertionKind",
  "isRecommendedDefaultAssertionKind",
  "deriveStageResults",
  "stageDerivationToMetadata",
  "mintCaseId",
  "mintSuiteId",
  "isOpaqueId",
  "buildEvalRunRouteFacts",
  "deriveTrialRoute",
  "classifyRouteTrial",
  "evalTrialRate",
  "buildDescriptionExperimentReport",
  "isPromptStep",
  "isToolCallStep",
  "isInteractStep",
  "isAssertStep",
  "isWidgetAssertion",
  "evaluateSuiteGateEvidence",
  "composeSuiteGateWithBaseReport",
  "parseSuiteGatePolicyForAuthoring",
  "parseSuiteGatePolicyForRead",
  "normalizeSuiteGatePolicy",
  "suiteGatePolicyHash",
  "resolveGradingPolicyFromSuiteFile",
  "resolveGradingPolicyFromHostedSuite",
  "resolveGradingPolicyFromRunReporting",
  "planEvalGradingPolicyEdit",
  "resolveEvalGradingIterations",
  "resolveEvalGradingValidityPolicy",
  "evalPassCriterionFraction",
  "hostedGradingStorageFromDto",
  "isEvalRunTerminalStatus",
  "isEvalRunPastExecution",
  "isEvalIterationTerminalStatus",
]) {
  if (typeof contract[n] !== "function") {
    throw new Error("missing contract export: " + n);
  }
}
for (const n of [
  "scoreResultSchema",
  "evaluatorResultSchema",
  "evaluatorResultArraySchema",
  "evaluatorKindSchema",
  "evaluatorStatusSchema",
  "EVALUATOR_KINDS",
  "EVALUATOR_RESULT_SCHEMA_VERSION",
  "EVALUATOR_STAGE",
  "ASSERTION_STAGE",
  "ASSERTION_KINDS",
  "EVALUATOR_PRESENTATION_GROUP",
  "RECOMMENDED_DEFAULT_ASSERTIONS",
  "PREDICATE_STAGE",
  "GRADER_STAGE",
  "resolvedScoreDefinitionSchema",
  "evaluationConfigSnapshotSchema",
  "PREDICATES_VERSION",
  "MAX_SCORER_ID_LENGTH",
  "TOOL_MATCH_SCORER_ID",
  "LEGACY_TEST_SCORER_ID",
  "opaqueIdSchema",
  "CASE_ID_PREFIX",
  "SUITE_ID_PREFIX",
  "USER_VALUE_STAGES",
  "STAGE_STATES",
  "FAILURE_CATEGORIES",
  "ITERATION_STATUSES",
  "IMPORT_MAPPING_STATUSES",
  "STAGE_ANALYZER_VERSION",
  "STAGE_REASONS",
  "STAGE_METADATA_KEYS",
  "MAX_EVIDENCE_REASONS",
  "MAX_EVIDENCE_REASON_CHARS",
  "stageDerivationSchema",
  "stageResultRowSchema",
  "stageReasonSchema",
  "TEST_STEP_KINDS",
  "testStepSchema",
  "stepsSchema",
  "elementLocatorSchema",
  "evalSuiteFileSchema",
  "evalSuiteFileStructuralSchema",
  "evalSuiteFileV2StructuralSchema",
  "evalSuiteFileV2JsonSchema",
  "EVAL_SUITE_SCHEMA_ID_V2",
  "EVAL_SUITE_SCHEMA_VERSION_2",
  "EVAL_SUITE_SCHEMA_VERSIONS",
  "MAX_ITERATIONS",
  "evalSuiteFileCaseSchema",
  "evalSuiteFileJsonSchema",
  "EVAL_SUITE_SCHEMA_ID",
  "EVAL_SUITE_SCHEMA_VERSION",
  "MAX_SUITE_FILE_CASES",
  "EVAL_RUN_ROUTE_FACTS_SCHEMA_VERSION",
  "ROUTE_FACTS_VERSION",
  "evalRunRouteFactsSchema",
  "EVAL_ROUTE_TAGS",
  "NO_TOOL_PATH_KEY",
  "buildDescriptionExperimentReport",
  "descriptionExperimentReportSchema",
  "DESCRIPTION_EXPERIMENT_SCHEMA_VERSION",
  "SUITE_GATE_SCHEMA_VERSION",
  "SUITE_GATE_EVALUATOR_VERSION",
  "suiteGatePolicySchema",
  "suiteGateEvidenceSchema",
  "suiteGateReportSchema",
  "EVAL_GRADING_POLICY_ORIGINS",
  "EVAL_GRADING_POLICY_REFUSALS",
  "EVAL_SUITE_WIDE_POPULATIONS",
  "EVAL_RUN_REPORTING_PRODUCERS",
  "DEFAULT_SUITE_WIDE_THRESHOLD_PERCENT",
  "LEGACY_SUITE_WIDE_THRESHOLD_PERCENT",
  "MAX_MINIMUM_ITERATIONS",
  "SUITE_FILE_VALIDITY_DEFAULTS",
  "SUITE_FILE_DEFAULT_COVERAGE",
  "evalGradingPolicySchema",
  "evalPassCriterionSchema",
  "evalIterationRuleSchema",
  "evalGradingValiditySchema",
  "EVAL_RUN_STATUSES",
  "EVAL_RUN_TERMINAL_STATUSES",
  "EVAL_ITERATION_TERMINAL_STATUSES",
  "evalRunStatusSchema",
]) {
  if (contract[n] === undefined) {
    throw new Error("missing contract export: " + n);
  }
}
if (contract.PREDICATE_STAGE !== contract.ASSERTION_STAGE) {
  throw new Error(
    "legacy contract export PREDICATE_STAGE is not the ASSERTION_STAGE object"
  );
}
if (contract.GRADER_STAGE !== contract.EVALUATOR_STAGE) {
  throw new Error(
    "legacy contract export GRADER_STAGE is not the EVALUATOR_STAGE object"
  );
}
for (const n of [
  "SUITE_FILE_VALIDITY_DEFAULTS",
  "SUITE_FILE_DEFAULT_COVERAGE",
]) {
  if (JSON.stringify(contract[n]) !== JSON.stringify(root[n])) {
    throw new Error(
      "contract and root disagree on " +
        n +
        ": the validity table has been forked"
    );
  }
}
if (
  contract.SUITE_FILE_VALIDITY_DEFAULTS.minCompletionRate !== 0.8 ||
  contract.SUITE_FILE_VALIDITY_DEFAULTS.maxEvaluatorErrorRate !== 0.1
) {
  throw new Error(
    "suite-file validity defaults are not the documented 0.8/0.1"
  );
}
if (
  contract.SUITE_FILE_DEFAULT_COVERAGE.kind !== "allConfiguredTrialsAttempted"
) {
  throw new Error(
    "an omitted minEligibleTrials must select the stricter coverage rule"
  );
}
if (
  typeof contract.evalSuiteFileJsonSchema !== "object" ||
  !contract.evalSuiteFileJsonSchema.properties?.cases
) {
  throw new Error(
    "contract export evalSuiteFileJsonSchema is not the generated JSON Schema document"
  );
}
await import("@mcpjam/sdk/host-config");
const w = await import("@mcpjam/sdk/widget-runtime");
for (const n of [
  "getToolVisibility",
  "isVisibleToModelOnly",
  "isVisibleToAppOnly",
  "LoggingTransport",
  "buildOuterAllowAttribute",
  "buildOuterSandboxAttribute",
  "resolveIframeSandboxPolicy",
  "createHostAppBridge",
  "registerHostBridgeHandlers",
]) {
  if (typeof w[n] !== "function") {
    throw new Error("missing widget-runtime export: " + n);
  }
}
if (w["DEFAULT_IFRAME_SANDBOX"] === undefined) {
  throw new Error("missing widget-runtime export: DEFAULT_IFRAME_SANDBOX");
}
const p = await import("@mcpjam/sdk/platform");
for (const n of [
  "PlatformApiClient",
  "PlatformApiError",
  "buildShowServersPayload",
  "resolveProject",
  "listProjectsOperation",
  "listProjectServersOperation",
  "showServersOperation",
  "checkHostCompatibilityOperation",
  "createTunnelOperation",
  "closeTunnelOperation",
]) {
  if (p[n] === undefined) {
    throw new Error("missing platform export: " + n);
  }
}
const m = await import("@mcpjam/sdk/host-config/internal");
for (const n of [
  "canonicalizeHostConfigV2",
  "computeHostConfigHashV2",
  "isAppOnlyTool",
  "filterAppOnlyTools",
  "applyVisibilityPolicyAndCountSignals",
  "applyToolDescriptionOverrides",
  "extractHostExecutionPolicy",
  "buildHostIterationMetadata",
  "resolveOpenAiCompatForHostConfig",
  "readOpenAiCompatOverride",
  "compatPresetForHostStyle",
  "normalizeSdkEvalHostConfigForWire",
]) {
  if (typeof m[n] !== "function") {
    throw new Error("missing export: " + n);
  }
}
const pub = await import("@mcpjam/sdk/public-api");
for (const n of [
  "isV1ErrorCode",
  "mapInternalCode",
  "v1ErrorBody",
  "v1Page",
  "classifyRuntimeError",
]) {
  if (typeof pub[n] !== "function") {
    throw new Error("missing public-api export: " + n);
  }
}
for (const n of ["V1_ERROR_CODES", "V1_ERROR_STATUS", "INTERNAL_TO_V1_CODE"]) {
  if (pub[n] === undefined) {
    throw new Error("missing public-api export: " + n);
  }
}
const hc = await import("@mcpjam/sdk/host-compat");
for (const n of [
  "deriveServerRequirements",
  "evaluateHostCompat",
  "evaluateAllHosts",
  "buildMarketHostProfiles",
  "evaluateMarketHosts",
  "scanWidgetUsage",
  "detectHostCompatBridgeFromMeta",
  "scanWidgetSource",
  "scanWidgetMeta",
  "bundledHostCompatCatalog",
  "buildHostProfilesFromCatalog",
  "fetchHostCompatCatalog",
  "hostConfigFieldsToImageSupport",
  "imageSupportToHostConfigFields",
]) {
  if (typeof hc[n] !== "function") {
    throw new Error("missing host-compat export: " + n);
  }
}
if (hc["HostCompatBridge"] === undefined) {
  throw new Error("missing host-compat export: HostCompatBridge");
}
for (const n of [
  "MCP_APPS_FULL",
  "MCP_APPS_CHATGPT",
  "MCP_APPS_MISTRAL",
  "MCP_APPS_CURSOR",
  "MCP_APPS_GOOSE",
  "MCP_APPS_COPILOT",
  "MCP_APPS_SLACK",
  "MCP_APPS_VSCODE",
  "MCP_APPS_NO_CLAIMS",
]) {
  if (typeof hc[n] !== "object") {
    throw new Error("missing host-compat capability export: " + n);
  }
}
for (const n of [
  "hostCompatCatalogSchema",
  "hostCompatCatalogEnvelopeSchema",
  "mcpAppsCapabilitiesSchema",
]) {
  if (hc[n] === undefined) {
    throw new Error("missing host-compat schema export: " + n);
  }
}
const iph = await import("@mcpjam/sdk/internal/plugin-host");
for (const n of [
  "createPluginCapabilityRegistry",
  "disabledPluginFeatures",
  "createPluginSession",
  "reducePluginSession",
  "pluginContextForTurn",
  "pluginInstanceKey",
]) {
  if (typeof iph[n] !== "function") {
    throw new Error("missing internal/plugin-host export: " + n);
  }
}
for (const n of [
  "createPluginSessionRunner",
  "createPluginWorkspaceReplay",
  "pluginWorkspaceCheckpoint",
]) {
  if (iph[n] !== undefined) {
    throw new Error("internal/plugin-host should not expose " + n);
  }
}
let publicPluginHost = false;
try {
  // Resolve rather than import, so an error raised while evaluating the module
  // cannot pass for the subpath being hidden.
  import.meta.resolve("@mcpjam/sdk/plugin-host");
  publicPluginHost = true;
} catch (error) {
  // Only "not exported" proves the subpath is hidden; anything else is a
  // broken build.
  if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
}
if (publicPluginHost) {
  throw new Error(
    "@mcpjam/sdk/plugin-host must stay unexported; use @mcpjam/sdk/internal/plugin-host"
  );
}
const pb = await import("@mcpjam/sdk/plugin-bundle");
for (const n of [
  "parsePluginBundle",
  "containsRootPlaceholder",
  "containsPluginPlaceholder",
  "selectPluginMcpServerMap",
  "detectPluginMcpTransport",
  "renderPluginApiKeyHeader",
  "pluginApiKeyHeaderName",
]) {
  if (typeof pb[n] !== "function") {
    throw new Error("missing plugin-bundle export: " + n);
  }
}
for (const n of [
  "DEFAULT_PLUGIN_BUNDLE_LIMITS",
  "PLUGIN_ISSUE_CODES",
  "PLUGIN_MANIFEST_SCHEMAS",
  "PLUGIN_MCP_SCHEMAS",
  "PLUGIN_MANIFEST_PATH",
  "PLUGIN_ROOT_PLACEHOLDERS",
  "PLUGIN_DATA_PLACEHOLDER",
  "PluginBundleError",
  "MCP_CONFIG_PATH",
  "PLUGIN_PARSER_REVISIONS",
]) {
  if (pb[n] === undefined) {
    throw new Error("missing plugin-bundle export: " + n);
  }
}
for (const n of [
  "normalizeBundlePath",
  "validateBundleEntries",
  "parseYamlLite",
  "caseFoldPath",
  "PluginIssueCollector",
  "sha256HexBytes",
  "computeAggregateHash",
]) {
  if (pb[n] !== undefined) {
    throw new Error("plugin-bundle should not re-export internal helper: " + n);
  }
}
const on = await import("@mcpjam/sdk/oauth/node");
for (const n of [
  "assertOutboundOAuthUrlAllowed",
  "isDisallowedIpAddress",
  "isLoopbackOAuthUrl",
  "isPrivateHost",
  "OAuthOutboundUrlBlockedError",
  "executeOAuthProxy",
  "executeDebugOAuthProxy",
  "fetchOAuthMetadata",
  "fetchPinnedPublicDocument",
  "validateUrl",
  "OAuthProxyError",
]) {
  if (typeof on[n] !== "function") {
    throw new Error("missing oauth/node export: " + n);
  }
}
const ev = await import("@mcpjam/sdk/events");
for (const n of [
  "EventsCoordinator",
  "MemoryEventInbox",
  "EventsPushRuntime",
  "computeRunKey",
  "computeDeliveryKey",
  "renderEventTurnMessages",
  "verifyWebhookDelivery",
  "redactRpcMessageForLog",
]) {
  if (typeof ev[n] !== "function") {
    throw new Error("missing events export: " + n);
  }
}
for (const n of ["runEventsConformance", "startEventsConformanceReceiver"]) {
  if (typeof root[n] !== "function") {
    throw new Error("missing events conformance export: " + n);
  }
}
