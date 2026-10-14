import { assembleEvalRunDecisionSummary } from "@mcpjam/sdk/contract";
import { FIXED_TIME, PROJECT_ID } from "./app-data";
export const SUITE_ID = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const RUN_ID = "ffffffffffffffffffffffffffffffff";
const cases = ["Current weather", "Unknown city"].map((title, index) => ({
  _id: `case-${index}`,
  testSuiteId: SUITE_ID,
  createdBy: "visual-user",
  projectId: PROJECT_ID,
  title,
  expectedOutput: index
    ? "Reject the unknown city with a clear validation message."
    : "Report the current weather in San Francisco.",
  query: index
    ? "Get the weather for an unknown city"
    : "What is the weather in San Francisco?",
  models: [{ model: "claude-sonnet-4-5", provider: "anthropic" }],
  runs: 1,
  expectedToolCalls: [
    {
      toolName: "get_weather",
      arguments: { city: index ? "Unknown City" : "San Francisco" },
    },
  ],
  createdAt: FIXED_TIME,
  updatedAt: FIXED_TIME,
}));
const suite = {
  _id: SUITE_ID,
  createdBy: "visual-user",
  projectId: PROJECT_ID,
  name: "Weather reliability",
  description: "Verify weather lookup and invalid-city handling.",
  configRevision: "visual-v1",
  environment: { servers: ["Weather"] },
  createdAt: FIXED_TIME,
  updatedAt: FIXED_TIME,
  source: "ui",
  tags: [],
};
const run = {
  _id: RUN_ID,
  suiteId: SUITE_ID,
  createdBy: "visual-user",
  projectId: PROJECT_ID,
  runNumber: 12,
  configRevision: "visual-v1",
  configSnapshot: { tests: cases, environment: suite.environment },
  status: "completed",
  createdAt: FIXED_TIME - 30000,
  startedAt: FIXED_TIME - 30000,
  completedAt: FIXED_TIME,
  updatedAt: FIXED_TIME,
  summary: { total: 2, passed: 1, failed: 1, cancelled: 0, pending: 0 },
  passCriteria: { minimumPassRate: 1 },
};
const iterations = cases.map((entry, index) => ({
  _id: `iteration-${index}`,
  testCaseId: entry._id,
  projectId: PROJECT_ID,
  suiteRunId: RUN_ID,
  testCaseSnapshot: {
    ...entry,
    model: "claude-sonnet-4-5",
    provider: "anthropic",
  },
  status: "completed",
  result: index ? "failed" : "passed",
  resultSource: "reported",
  actualToolCalls: [
    {
      toolName: "get_weather",
      arguments: { city: index ? "Unknown City" : "San Francisco" },
    },
  ],
  iterationNumber: index + 1,
  stageAnalyzerVersion: 4,
  stageResults: [
    "connection",
    "discovery",
    "selection",
    "call",
    "response",
    "userValue",
  ].map((stage) => ({
    stage,
    state: index && stage === "userValue" ? "failed" : "passed",
    reason: index && stage === "userValue" ? "predicateFailed" : "observed",
  })),
  tokensUsed: 640,
  startedAt: FIXED_TIME - 20000,
  updatedAt: FIXED_TIME,
  completedAt: FIXED_TIME,
  ...(index
    ? {
        firstFailedStage: "userValue",
        failureCategory: "userValue",
      }
    : {}),
}));
export const evalQueries = {
  "evalFindingsPipelineState:getEvalIterationReport": null,
  "computerEnvironments:listEnvironments": [],
  "testSuites:getSuiteCapabilities": {},
  "hostConfigsV2:getSuiteConfig": null,
  "serverAttachments:listServerAttachments": [],
  "serverQuality:getEvalRunInsightsEnvelope": null,
  "testSuites:getTestSuitesOverview": [
    {
      suite,
      latestRun: run,
      recentRuns: [run],
      passRateTrend: [],
      totals: { passed: 1, failed: 1, runs: 1 },
    },
  ],
  "testSuites:listTestCases": cases,
  "testSuites:listTestSuiteRunSummaries": {
    page: [run],
    isDone: true,
    continueCursor: "",
  },
  "testSuites:getTestSuiteRun": run,
  "testSuites:getTestSuiteRunDetails": { run, iterations },
  "testSuites:listTestSuiteRunIterations": {
    page: iterations,
    isDone: true,
    continueCursor: "",
  },
};

const apiIterations = iterations.map((entry, index) => ({
  ...entry,
  id: entry._id,
  iterationNumber: index + 1,
  title: cases[index].title,
  expectedToolCalls: cases[index].expectedToolCalls,
}));
export const evalStatuses = {
  [`/api/v1/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/compare`]: 404,
};
export const evalResponses = {
  [`/api/v1/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/compare`]: {
    error: {
      code: "NOT_FOUND",
      message: "No earlier completed run",
      details: { reason: "BASELINE_NOT_FOUND" },
    },
  },
  [`/api/v1/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/iterations`]: {
    items: apiIterations,
  },
  [`/api/v1/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/decision-summary`]:
    assembleEvalRunDecisionSummary({
      projectId: PROJECT_ID,
      run: {
        id: RUN_ID,
        status: "completed",
        result: "failed",
        summary: run.summary,
      },
      iterations: apiIterations,
      page: { complete: true },
    }),
};
