/**
 * Wire DTOs for the MCPJam Platform API (`/api/v1`).
 *
 * These mirror the public projections documented in the repo OpenAPI spec
 * (`docs/reference/openapi.json`) and emitted by the Convex catalog reads
 * (`mcpjam-backend/convex/publicApi/dtos.ts`). Write tolerant readers:
 * additive fields are non-breaking and must be ignored, never relied on
 * being absent.
 */
import type { ServerDoctorResult } from "../server-doctor-core.js";

/** Collection envelope: `nextCursor` is omitted on the last page. */
export type PlatformPage<TItem> = {
  items: TItem[];
  nextCursor?: string;
};

export interface PlatformMe {
  id: string;
  email: string;
  name: string;
  imageUrl: string | null;
  profilePictureUrl: string | null;
  plan: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface PlatformProject {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  organizationId: string | null;
  visibility: string | null;
  /** Caller's role on the project when the upstream query resolves one. */
  role?: string;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface PlatformProjectServer {
  id: string;
  projectId: string | null;
  name: string;
  enabled: boolean;
  transportType: string;
  /** Endpoint for HTTP-transport servers; null for stdio. */
  url: string | null;
  useOAuth: boolean;
  hasClientSecret: boolean;
  oauthScopes?: string[];
  createdAt: number | null;
  updatedAt: number | null;
}

export interface PlatformEvalRunSummary {
  id: string | null;
  status: string | null;
  passRate: number | null;
  passed: number | null;
  failed: number | null;
  createdAt: number | null;
}

export interface PlatformEvalSuite {
  id: string;
  name: string | null;
  projectId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  latestRun: PlatformEvalRunSummary | null;
  totals: { passed: number; failed: number; runs: number };
  passRateTrend: number[];
}

export interface PlatformChatSession {
  id: string;
  title: string | null;
  status: string | null;
  projectId: string | null;
  /** "private" | "project". */
  visibility: string | null;
  lastActivityAt: number | null;
  createdAt: number | null;
  isPinned?: boolean;
  isUnread?: boolean;
}

/**
 * Response of `POST /projects/{p}/servers/{s}/doctor` — the hosted doctor
 * result, passed through verbatim by the API. Includes the probe outcome,
 * connection state, and full tools/resources/prompts listings with
 * per-collection checks, which is why `show_servers` needs only one call
 * per server.
 */
export type PlatformDoctorReport = ServerDoctorResult<unknown>;
