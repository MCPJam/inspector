/**
 * Typed fetch client for the MCPJam public API (v1).
 *
 * Two surfaces, two bases (no unified gateway yet — see the v1 host decision):
 *   - "convex"    -> ${CONVEX_HTTP_URL}/v1/*      read-only product state
 *   - "inspector" -> ${INSPECTOR_API_BASE}/api/v1/*  live MCP + diagnostics
 *
 * The caller's bearer token is forwarded verbatim. Non-2xx responses are parsed
 * as the canonical v1 error envelope ({ code, message, details? }) and raised as
 * PublicApiError.
 *
 * The DTOs below are duplicated (by deliberate choice — no shared package in
 * v1) from mcpjam-backend/convex/publicApi/dtos.ts. Both copies are pinned to
 * the same golden fixtures via contract tests; keep them in sync.
 */

export type V1ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "FEATURE_NOT_SUPPORTED"
  | "SERVER_UNREACHABLE"
  | "TIMEOUT"
  | "OAUTH_REQUIRED"
  | "INTERNAL_ERROR";

export interface V1Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface MeDto {
  id: string;
  email: string;
  name: string;
  imageUrl: string | null;
  profilePictureUrl: string | null;
  plan: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  organizationId: string | null;
  visibility: string | null;
  role?: string;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface ServerDto {
  id: string;
  projectId: string | null;
  name: string;
  enabled: boolean;
  transportType: string;
  url: string | null;
  useOAuth: boolean;
  hasClientSecret: boolean;
  oauthScopes?: string[];
  createdAt: number | null;
  updatedAt: number | null;
}

export interface ChatSessionDto {
  id: string;
  title: string | null;
  status: string | null;
  projectId: string | null;
  visibility: string | null;
  lastActivityAt: number | null;
  createdAt: number | null;
  isPinned?: boolean;
  isUnread?: boolean;
}

export interface EvalSuiteDto {
  id: string;
  name: string | null;
  projectId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  latestRun: unknown;
  totals: { passed: number; failed: number; runs: number };
  passRateTrend: number[];
}

export type PublicApiSurface = "convex" | "inspector";

/** Subset of the worker runtime env the client needs. */
export interface PublicApiClientEnv {
  CONVEX_HTTP_URL: string;
  INSPECTOR_API_BASE: string;
}

/** Raised on any non-2xx v1 response, carrying the canonical error code. */
export class PublicApiError extends Error {
  readonly code: V1ErrorCode | string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: V1ErrorCode | string,
    message: string,
    status: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PublicApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class PublicApiClient {
  constructor(
    private readonly env: PublicApiClientEnv,
    private readonly bearerToken: string
  ) {}

  private baseFor(surface: PublicApiSurface): string {
    return surface === "convex"
      ? `${this.env.CONVEX_HTTP_URL}/v1`
      : `${this.env.INSPECTOR_API_BASE}/api/v1`;
  }

  get<T>(surface: PublicApiSurface, path: string): Promise<T> {
    return this.request<T>(surface, "GET", path);
  }

  post<T>(
    surface: PublicApiSurface,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    return this.request<T>(surface, "POST", path, body);
  }

  private async request<T>(
    surface: PublicApiSurface,
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.baseFor(surface)}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.bearerToken}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json: any = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // Non-JSON body — surfaced via the status-only error path below.
      }
    }

    if (!res.ok) {
      const code =
        typeof json?.code === "string" ? json.code : "INTERNAL_ERROR";
      const message =
        typeof json?.message === "string"
          ? json.message
          : `Request to ${path} failed with status ${res.status}`;
      const details =
        json && typeof json.details === "object" ? json.details : undefined;
      throw new PublicApiError(code, message, res.status, details);
    }

    return json as T;
  }
}

export function createPublicApiClient(
  env: PublicApiClientEnv,
  bearerToken: string
): PublicApiClient {
  return new PublicApiClient(env, bearerToken);
}

/** Build a `?a=b&c=d` string, dropping empty/undefined params. */
export function toQuery(
  params: Record<string, string | number | undefined | null>
): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      sp.set(key, String(value));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}
