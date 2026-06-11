import { PlatformApiError } from "./errors.js";
import type {
  PlatformChatbox,
  PlatformChatboxDetail,
  PlatformChatSession,
  PlatformDoctorReport,
  PlatformEvalIteration,
  PlatformEvalRun,
  PlatformEvalRunCreated,
  PlatformEvalSuite,
  PlatformMe,
  PlatformPage,
  PlatformProject,
  PlatformProjectServer,
} from "./types.js";

export const DEFAULT_PLATFORM_API_BASE_URL = "https://app.mcpjam.com/api/v1";

export interface PlatformApiClientOptions {
  /** API origin + version prefix. Defaults to the hosted production API. */
  baseUrl?: string;
  /**
   * Returns the bearer credential for each request: an `sk_` API key or a
   * WorkOS user JWT. Called per request so rotating/refreshing credentials
   * stay current.
   */
  getAuth: () => string | Promise<string>;
  /** Injectable fetch for tests and exotic runtimes. */
  fetch?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Optional User-Agent; ignored by browsers (forbidden header). */
  userAgent?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

type QueryParams = Record<string, string | number | undefined>;

type RequestOptions = {
  signal?: AbortSignal;
};

type ServerScope = {
  projectId: string;
  serverId: string;
};

/**
 * Minimal fetch-based client for the MCPJam Platform API. Runtime-agnostic
 * by construction (Workers/browser/Node): native fetch only, no Node
 * built-ins, no ambient environment reads — credentials and base URL are
 * injected. Tolerant reader: unknown response fields pass through untouched,
 * and empty success bodies (204) resolve to `undefined`.
 */
export class PlatformApiClient {
  private readonly baseUrl: string;
  private readonly getAuth: () => string | Promise<string>;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent?: string;

  constructor(options: PlatformApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_PLATFORM_API_BASE_URL).replace(
      /\/+$/,
      ""
    );
    this.getAuth = options.getAuth;
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent;
  }

  getMe(options?: RequestOptions): Promise<PlatformMe> {
    return this.request("GET", "/me", {}, options);
  }

  listProjects(
    params: { organizationId?: string } = {},
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformProject>> {
    return this.request(
      "GET",
      "/projects",
      { query: { organizationId: params.organizationId } },
      options
    );
  }

  listProjectServers(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformProjectServer>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/servers`,
      {},
      options
    );
  }

  listEvalSuites(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalSuite>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/eval-suites`,
      {},
      options
    );
  }

  listChatSessions(
    params: {
      projectId?: string;
      status?: string;
      limit?: number;
      before?: string;
    } = {},
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformChatSession>> {
    return this.request(
      "GET",
      "/chat-sessions",
      {
        query: {
          projectId: params.projectId,
          status: params.status,
          limit: params.limit,
          before: params.before,
        },
      },
      options
    );
  }

  listChatboxes(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformChatbox>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/chatboxes`,
      {},
      options
    );
  }

  getChatbox(
    params: { projectId: string; chatboxId: string },
    options?: RequestOptions
  ): Promise<PlatformChatboxDetail> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/chatboxes/${encodeURIComponent(params.chatboxId)}`,
      {},
      options
    );
  }

  /**
   * `POST /projects/{p}/eval-runs` — validates and creates the run, then
   * detaches execution and responds 202. Poll `getEvalRun` until terminal.
   */
  createEvalRun(
    params: { projectId: string; body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformEvalRunCreated> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/eval-runs`,
      { body: params.body },
      options
    );
  }

  getEvalRun(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalRun> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}`,
      {},
      options
    );
  }

  listEvalRunIterations(
    params: {
      projectId: string;
      runId: string;
      cursor?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalIteration>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}/iterations`,
      { query: { cursor: params.cursor, limit: params.limit } },
      options
    );
  }

  /** Full trace envelope (messages + analysis) for one iteration. */
  getEvalIterationTrace(
    params: { projectId: string; runId: string; iterationId: string },
    options?: RequestOptions
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(
        params.runId
      )}/iterations/${encodeURIComponent(params.iterationId)}/trace`,
      {},
      options
    );
  }

  listEvalSuiteRuns(
    params: { projectId: string; suiteId: string; limit?: number },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalRun>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/runs`,
      { query: { limit: params.limit } },
      options
    );
  }

  validateServer(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "validate", options);
  }

  doctorServer(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformDoctorReport> {
    return this.serverOp(params, "doctor", options);
  }

  exportServer(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "export", options);
  }

  listServerTools(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformPage<Record<string, unknown>>> {
    return this.serverOp(params, "tools", options);
  }

  listServerResources(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformPage<Record<string, unknown>>> {
    return this.serverOp(params, "resources", options);
  }

  listServerPrompts(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformPage<Record<string, unknown>>> {
    return this.serverOp(params, "prompts", options);
  }

  private serverOp<T>(
    params: ServerScope & { body?: Record<string, unknown> },
    op: string,
    options?: RequestOptions
  ): Promise<T> {
    const path = `/projects/${encodeURIComponent(
      params.projectId
    )}/servers/${encodeURIComponent(params.serverId)}/${op}`;
    return this.request("POST", path, { body: params.body ?? {} }, options);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    init: { query?: QueryParams; body?: unknown },
    options?: RequestOptions
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.getAuth()}`,
    };
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.userAgent) {
      headers["user-agent"] = this.userAgent;
    }

    const controller = new AbortController();
    const externalSignal = options?.signal;
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        onExternalAbort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, {
          once: true,
        });
      }
    }
    const timeoutHandle = setTimeout(
      () => controller.abort(new Error(`Request timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs
    );

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (externalSignal?.aborted) {
        // Caller-initiated abort: propagate, don't dress it up as an API error.
        throw error;
      }
      const aborted = controller.signal.aborted;
      throw new PlatformApiError(
        aborted
          ? `Request to ${path} timed out after ${this.timeoutMs}ms`
          : `Failed to reach the MCPJam API at ${url.origin}: ${errorMessage(error)}`,
        aborted ? "TIMEOUT" : "NETWORK_ERROR",
        { status: 0, endpoint: path, cause: error }
      );
    } finally {
      clearTimeout(timeoutHandle);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      throw new PlatformApiError(
        `Failed to read the MCPJam API response (${response.status}) for ${path}`,
        "INTERNAL_ERROR",
        { status: response.status, endpoint: path, cause: error }
      );
    }

    let parsed: unknown;
    let parseError: unknown;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        parseError = error;
      }
    }

    if (!response.ok) {
      // Empty and non-JSON error bodies (bare 429s, proxy HTML) still map to
      // a PlatformApiError keyed off the status, with Retry-After preserved.
      throw this.toApiError(response, parsed, path);
    }

    if (parseError !== undefined) {
      throw new PlatformApiError(
        `The MCPJam API returned a non-JSON response (${response.status}) for ${path}`,
        "INTERNAL_ERROR",
        { status: response.status, endpoint: path, cause: parseError }
      );
    }

    // Empty success bodies (204 / no content) resolve to undefined.
    return parsed as T;
  }

  private toApiError(
    response: Response,
    body: unknown,
    path: string
  ): PlatformApiError {
    const envelope =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { code?: unknown; message?: unknown; details?: unknown })
        : undefined;
    const code =
      typeof envelope?.code === "string" && envelope.code.length > 0
        ? envelope.code
        : fallbackCodeForStatus(response.status);
    const message =
      typeof envelope?.message === "string" && envelope.message.length > 0
        ? envelope.message
        : `Request to ${path} failed (${response.status})`;
    const details =
      envelope?.details &&
      typeof envelope.details === "object" &&
      !Array.isArray(envelope.details)
        ? (envelope.details as Record<string, unknown>)
        : undefined;

    return new PlatformApiError(message, code, {
      status: response.status,
      details,
      retryAfter: parseRetryAfter(response.headers.get("retry-after")),
      endpoint: path,
    });
  }
}

// Wire codes assumed when an error response carries no `{ code }` envelope
// (empty bodies, upstream proxy HTML). Statuses without an unambiguous v1
// code fall back to INTERNAL_ERROR.
const STATUS_FALLBACK_CODES: Record<number, string> = {
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  429: "RATE_LIMITED",
};

function fallbackCodeForStatus(status: number): string {
  return STATUS_FALLBACK_CODES[status] ?? "INTERNAL_ERROR";
}

function parseRetryAfter(
  header: string | null,
  now: number = Date.now()
): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }

  // RFC 9110 also allows an HTTP-date form.
  const retryAt = Date.parse(header);
  if (Number.isNaN(retryAt)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
