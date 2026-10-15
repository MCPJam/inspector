import {
  bundledHostCompatCatalog,
  SUPPORTED_CATALOG_SCHEMA_VERSION,
} from "@mcpjam/sdk/host-compat";

export const PROJECT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FIXED_TIME = 1768478400000;
const project = {
  _id: PROJECT_ID,
  name: "Visual Pilot",
  ownerId: "visual-user",
  servers: {},
  createdAt: FIXED_TIME,
  updatedAt: FIXED_TIME,
};

// These values exercise the real application's guest workspace, without a
// WorkOS session or live Convex data. Unknown operations fail the capture.
export const queries: Record<string, unknown> = {
  "users:getCurrentUser": {
    _id: "visual-user",
    name: "Visual Pilot",
    isGuest: true,
  },
  "projects:getMyProjects": [project],
  "organizations:getMyOrganizations": [],
  "organizations:getMyPendingOrganizationDeletions": [],
  "servers:getProjectServers": [],
  "servers:listForProjects": {},
  "hostConfigsV2:getProjectDefault": null,
  "projectServerConfig:getConfig": null,
  "notifications:getMyNotifications": [],
  "notifications:getUnreadCount": 0,
  "telemetryPrivacy:getContext": { recording: "off", identity: "id_only" },
  "projectSecrets:listSecrets": [],
  "billing:getCreditBalance": null,
  "organizationModelProviders:getVisibleConfigForProject": { providers: [] },
  "hosts:listHosts": [],
  "projects:getProjectMembers": { members: [], canManageMembers: false },
};

export const responses: Record<string, unknown> = {
  "/api/session-token": { ok: true },
  "/api/web/capabilities": {
    hostedMode: false,
    hostedServices: false,
    hostedUrl: "https://app.mcpjam.com",
    hostedOnly: [],
    degraded: [],
  },
  "/api/web/guest-session": {
    guestId: "visual-guest",
    token: "synthetic-guest-token",
    expiresAt: 4102444800000,
  },
  "/api/web/flags": { flags: {} },
  "/api/mcp-cli-config": { mcpServers: {} },
  "/api/mcp/servers": { servers: {} },
  "/api/v1/host-catalog": {
    schemaVersion: SUPPORTED_CATALOG_SCHEMA_VERSION,
    version: 1,
    contentHash: "visual-fixture",
    publishedAt: FIXED_TIME,
    catalog: bundledHostCompatCatalog(),
  },
  "/api/version": { version: "3.15.0" },
  "/api/web/computers/config": { enabled: false },
  "/api/mcp/models": { models: [] },
  "/api/mcp/tokenizer/count-text": { tokenCount: 0 },
  "/api/tags": { models: [] },
};
