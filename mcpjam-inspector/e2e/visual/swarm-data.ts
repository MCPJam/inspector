import type {
  JourneyRun,
  JourneySessionRow,
  SwarmOverview,
} from "../../client/src/lib/swarm-api";
import { FIXED_TIME, PROJECT_ID } from "./app-data";
import { memberFixture } from "./product-data";
import type { AppFixture } from "./app-network";

const personaId = "11111111111111111111111111111111";
const journeyId = "22222222222222222222222222222222";
const hostId = "33333333333333333333333333333333";
const runId = "44444444444444444444444444444444";
const overview: SwarmOverview = {
  runs: [
    {
      runId,
      journeyRefId: journeyId,
      journeyName: "Plan a weather-safe walk",
      journeyArchived: false,
      personaName: "Weekend traveler",
      createdAt: FIXED_TIME - 3600000,
      status: "completed",
      summary: { total: 3, succeeded: 3, failed: 0, rateLimited: 0 },
      goalScoreSummary: {
        gradedCount: 3,
        passedCount: 2,
        avgScore: 2 / 3,
        pendingCount: 0,
        failedCount: 0,
      },
      findings: [
        {
          criterionId: "city-check",
          label: "Clarify an unknown city",
          kind: "toolCalledAtLeastOnce",
          failCount: 1,
          pendingCount: 0,
          failedGradingCount: 0,
          sessionsGraded: 3,
          runStreak: 1,
        },
      ],
      targets: [
        { hostName: "Weather assistant", modelId: "openai/gpt-4o-mini" },
      ],
    },
  ],
  runsConsidered: 1,
  goalCompletion: {
    gradedCount: 3,
    passedCount: 2,
    passRate: 2 / 3,
    runsWithGrades: 1,
    trend: [],
  },
};
const run: JourneyRun = {
  _id: runId,
  status: "completed",
  summary: overview.runs[0].summary,
  hostSummaries: [{ hostId, ...overview.runs[0].summary }],
  snapshot: {
    hosts: [
      { hostId, hostName: "Weather assistant", modelId: "openai/gpt-4o-mini" },
    ],
    sessionsPerTarget: 3,
  },
  goalScoreSummary: overview.runs[0].goalScoreSummary,
  createdAt: FIXED_TIME - 3600000,
};
const sessions: JourneySessionRow[] = [
  "Is it warm enough for a walk in San Francisco?",
  "Will I need a jacket in Seattle?",
  "What is the weather in an unknown city?",
].map((firstMessagePreview, index) => ({
  id: `visual-swarm-session-${index}`,
  chatSessionId: `synthetic-weather-${index}`,
  projectId: PROJECT_ID,
  hostId,
  personaRefId: personaId,
  journeyRunId: runId,
  journeyRefId: journeyId,
  status: "completed",
  modelId: "openai/gpt-4o-mini",
  startedAt: FIXED_TIME - 3600000 + index * 60000,
  messageCount: 4,
  firstMessagePreview,
  personaLabel: "Weekend traveler",
  synthetic: true,
  criteria: {
    status: "completed",
    generation: 1,
    results: [{ criterionId: "city-check", passed: index !== 2 }],
  },
}));
export const swarmFixture: AppFixture = {
  ...memberFixture,
  responses: {
    ...memberFixture.responses,
    "/api/web/flags": { flags: { "sandboxes-enabled": true } },
  },
  queries: {
    ...memberFixture.queries,
    "projects:getProjectMembers": [
      { email: "visual@example.invalid", role: "admin", isPending: false },
    ],
    "journeyRuns:getSwarmSessionMetrics": {
      sessionCount: 3,
      analyzedCount: 3,
      truncated: false,
      toolCallCount: 3,
      toolErrorCount: 1,
      toolErrorRate: 1 / 3,
      sessionsWithToolErrors: 1,
      topFailingTool: { toolName: "get_weather", errorCount: 1 },
      avgToolCallsPerSession: 1,
      latencyP50Ms: 1200,
      latencyP95Ms: 2400,
      avgTokensPerSession: 600,
      tokenSampleCount: 3,
      trend: [],
    },
    "personas:listPersonas": [
      {
        _id: personaId,
        personaId: "weekend-traveler",
        name: "Weekend traveler",
        role: "Traveler planning outdoor activities",
        notes:
          "Wants practical weather advice and clear handling of unfamiliar cities.",
        avatarShape: 1,
        avatarPalette: 2,
      },
    ],
    "personas:getPersonaTrackRecord": {
      runCount: 1,
      sessionCount: 3,
      goalScore: { gradedCount: 3, passedCount: 2, avgScore: 2 / 3 },
    },
    "journeys:listJourneysByPersona": [
      {
        _id: journeyId,
        personaRefId: personaId,
        name: "Plan a weather-safe walk",
        goal: "Check the weather and recommend whether to bring a jacket.",
        hostIds: [hostId],
        config: { sessionsPerTarget: 3, maxTurns: 8 },
      },
    ],
    "hosts:listHosts": [
      {
        hostId,
        name: "Weather assistant",
        modelId: "openai/gpt-4o-mini",
        serverCount: 1,
      },
    ],
    "journeyRuns:listRunningPersonaRefIds": [],
    "journeyRuns:getSwarmOverview": overview,
    "serverAttachments:listServerAttachments": [],
    "journeyRuns:listJourneyRuns": {
      page: [run],
      isDone: true,
      continueCursor: "",
    },
    "journeys:getJourneyRollup": {
      journeyRefId: journeyId,
      runCount: 1,
      hosts: run.hostSummaries,
    },
    "journeyRuns:listSessionsByProject": {
      page: sessions,
      isDone: true,
      continueCursor: "",
    },
  },
};
