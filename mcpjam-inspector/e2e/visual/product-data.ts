import { FIXED_TIME, PROJECT_ID } from "./app-data";
import type { AppFixture } from "./app-network";
export const ORGANIZATION_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const userId = "cccccccccccccccccccccccccccccccc";
const token =
  [
    { alg: "none" },
    {
      sub: "user_visual",
      sid: "session_visual",
      exp: 4102444800,
      iat: 1768478400,
    },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".") + ".synthetic";
export const server = {
  _id: "dddddddddddddddddddddddddddddddd",
  projectId: PROJECT_ID,
  name: "Weather",
  enabled: true,
  transportType: "http",
  url: "https://weather.visual.invalid/mcp",
  authMethod: "none",
  createdAt: FIXED_TIME,
  updatedAt: FIXED_TIME,
};
export const weatherTool = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "City to get the weather for" },
    },
    required: ["city"],
  },
};
export const memberFixture: AppFixture = {
  signedIn: true,
  mutations: { "productUpdates:initializeIfNeeded": null },
  queries: {
    "organizationModelProviders:getVisibleConfig": { providers: [] },
    "projectEnvironments:getCapabilities": {},
    "projectEnvironments:listEnvironments": [],
    "testSuites:getTestSuitesOverview": [],
    "servers:getProjectServers": [server],
    "servers:listForProjects": { [PROJECT_ID]: [server] },
    "billing:getOrganizationBillingStatus": {
      organizationId: ORGANIZATION_ID,
      plan: "team",
    },
    "billing:getOrganizationBillingBundle": {
      billingStatus: { organizationId: ORGANIZATION_ID, plan: "team" },
      entitlements: { plan: "team", features: {}, limits: {} },
      organizationPremiumness: {
        plan: "team",
        effectivePlan: "team",
        enforcementState: "active",
        decisionRequired: false,
        gates: [],
      },
      projectPremiumness: {
        plan: "team",
        effectivePlan: "team",
        enforcementState: "active",
        decisionRequired: false,
        gates: [],
      },
      planCatalog: null,
    },
    "billing:getEvalIterationQuota": {
      used: 24,
      allowed: 1000,
      resetsAt: 1770000000000,
      windowKind: "month",
    },
    "productUpdates:listVisibleUpdates": [],
    "orgSharedSlackChannels:getForOrganization": {
      channel: null,
      canProvision: false,
      canManageInvite: false,
    },
    "home:getOrgHomeData": {
      memberCount: 3,
      projects: [{ _id: PROJECT_ID, name: "Weather Assistant" }],
      totalServerCount: 1,
      evalSuiteCount: 1,
      recommendedServers: [],
      members: [
        {
          _id: userId,
          name: "Visual Pilot",
          email: "visual@example.invalid",
          imageUrl: null,
        },
      ],
    },
    "orgMetrics:getOrgMetric": {
      value: 128,
      refreshedAt: FIXED_TIME,
      windowDays: 30,
    },
    "users:getCurrentUser": {
      _id: userId,
      name: "Visual Pilot",
      email: "visual@example.invalid",
      workosUserId: "user_visual",
      occupation: "Automated visual testing",
      isGuest: false,
    },
    "organizations:getMyOrganizations": [
      {
        _id: ORGANIZATION_ID,
        name: "Acme Labs",
        myRole: "admin",
        plan: "team",
        createdAt: FIXED_TIME,
      },
    ],
    "projects:getMyProjects": [
      {
        _id: PROJECT_ID,
        name: "Weather Assistant",
        organizationId: ORGANIZATION_ID,
        ownerId: userId,
        servers: {},
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  },
  responses: {
    "/api/web/tasks/capabilities": { supported: false },
    "/api/web/servers/check-oauth": {
      useOAuth: false,
      requiresAuthorization: false,
      effectiveAuthMethod: "none",
      serverUrl: server.url,
    },
    "/api/web/servers/validate": {
      success: true,
      status: "connected",
      initInfo: {
        serverInfo: { name: "Weather", version: "1.0.0" },
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
      },
    },
    "/api/web/tools/list": { tools: [weatherTool] },
    "/api/web/tools/execute": {
      status: "completed",
      result: {
        content: [{ type: "text", text: "San Francisco: 18°C, sunny" }],
        structuredContent: {
          city: "San Francisco",
          temperature: 18,
          condition: "Sunny",
        },
      },
    },
    "/api/web/guest-session/revoke": { ok: true },
    "/api/web/swarm/funding-preview": {
      supported: true,
      remaining: 500,
      granted: 500,
      runs: [],
    },
    "/user_management/authenticate": {
      access_token: token,
      refresh_token: "synthetic-refresh",
      authentication_method: "Password",
      user: {
        object: "user",
        id: "user_visual",
        first_name: "Visual",
        last_name: "Pilot",
        email: "visual@example.invalid",
        email_verified: true,
        created_at: "2026-01-15T12:00:00Z",
        updated_at: "2026-01-15T12:00:00Z",
      },
    },
  },
};
