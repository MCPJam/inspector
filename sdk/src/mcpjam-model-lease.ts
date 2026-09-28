/**
 * MCPJam-hosted inference for evals that run OUTSIDE the platform.
 *
 * The problem this solves: an eval in your CI needs a model, and until now that
 * meant an OpenAI or Anthropic key in your repository secrets. With a
 * `mcpjam/…` model id the only secret is `MCPJAM_API_KEY` — MCPJam calls the
 * provider and bills your organization's credits.
 *
 * How it works, and why it is a `fetch` rather than a new provider:
 *
 *   1. MCPJam's model proxy is VENDOR-COMPATIBLE — it speaks Anthropic's
 *      `/v1/messages` and OpenAI's `/v1/responses`. So `@ai-sdk/anthropic` and
 *      `@ai-sdk/openai` can talk to it unchanged, and there is no custom
 *      `LanguageModel` to write or keep in step with the AI SDK.
 *   2. What the proxy needs instead of a provider key is a LEASE: short-lived,
 *      scoped to one org + project + model, presented in a header the AI SDK
 *      knows nothing about, and only obtainable by an authenticated call.
 *   3. The lease's URL is not knowable until it is minted (the proxy origin is
 *      deployment-specific), so the provider is pointed at a placeholder and
 *      this `fetch` rewrites it.
 *
 * Which leaves one credential rule, enforced in `proxyFetch`: the `sk_` key is
 * used ONLY against MCPJam's own API to mint, and the placeholder key the
 * provider was constructed with is stripped before the request leaves. Neither
 * ever reaches the proxy.
 */

/** A minted lease and everything needed to spend it. */
export interface McpjamModelLease {
  /** Presented as `x-mcpjam-harness-lease`. Never a bearer token. */
  lease: string;
  protocol: "anthropic" | "openai";
  /** Deployment-specific proxy base, e.g. `https://…/model-proxy/anthropic`. */
  proxyBaseUrl: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Revocation key, and what ties every generation to one run. */
  runId: string;
}

/** A refusal from MCPJam's lease endpoint, with the API's own code. */
export class McpjamLeaseError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  /**
   * The refusal's structured `details`, when the API sent an object there.
   *
   * Kept because a status alone cannot say what was refused: the v1 envelope
   * files a free-tier model restriction under `FORBIDDEN`, and only the nested
   * code tells it apart from a key that may not use the project. See
   * {@link classifyMcpjamLeaseError}.
   */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options: {
      code?: string;
      status: number;
      retryAfterSeconds?: number;
      details?: Record<string, unknown>;
    }
  ) {
    super(message);
    this.name = "McpjamLeaseError";
    this.code = options.code ?? "UNKNOWN";
    this.status = options.status;
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
    if (options.details !== undefined) {
      this.details = Object.freeze({ ...options.details });
    }
  }
}

/**
 * What a lease refusal was ABOUT, for a caller deciding whose problem it is.
 *
 *   - `billing`: the organization cannot spend right now — credits, the free
 *     allowance, a spend budget, a locked wallet. Not a credential problem, and
 *     retrying does not help.
 *   - `auth`: the credentials were missing or rejected, or are not entitled to
 *     this project — including a 403 that carries NO billing detail.
 *   - `rateLimited`: a throttle that clears by waiting.
 *   - `unavailable`: MCPJam could not answer (5xx, timeout, an unrecognized
 *     lease body).
 *   - `other`: anything else, e.g. a request the API refused as malformed.
 */
export type McpjamLeaseRefusalKind =
  "billing" | "auth" | "rateLimited" | "unavailable" | "other";

/**
 * The account-limit codes MCPJam's spend gates refuse with — the same
 * vocabulary the Inspector's swarm retry policy recognizes as an account
 * limit rather than a provider's own throttle.
 */
const BILLING_REFUSAL_CODE =
  /^(?:user_rate_limit|org_rate_limit|mcpjam_rate_limit|billing_limit_reached|spend_budget_reached|organization_spend_budget_reached|wallet_locked|billing_feature_not_included|free_tier_model_restricted|spend_cap_exceeded|platform_free_budget_exhausted|spending_admission_invalid|insufficient_credits)$/i;

const AUTH_REFUSAL_CODE =
  /^(?:unauthorized|oauth_required|invalid_api_key|auth_unavailable|account_suspended)$/i;

/** Every code-shaped string a refusal carries, top level and nested. */
function refusalCodes(error: McpjamLeaseError): string[] {
  const codes = [error.code];
  const details = error.details;
  if (details) {
    for (const key of ["code", "reason", "refusalReason", "billingCode"]) {
      const value = details[key];
      if (typeof value === "string" && value.length > 0) codes.push(value);
    }
  }
  return codes;
}

/**
 * Classify a lease refusal. Reads the codes BEFORE the status: a billing code
 * wins wherever it appears, because an auth-shaped envelope (`FORBIDDEN`,
 * 403) wrapping a free-tier or spend refusal is still a billing refusal, and
 * reporting it as bad credentials would send someone to rotate a key that
 * works.
 */
export function classifyMcpjamLeaseError(
  error: McpjamLeaseError
): McpjamLeaseRefusalKind {
  const codes = refusalCodes(error);
  if (codes.some((code) => BILLING_REFUSAL_CODE.test(code))) return "billing";
  if (
    error.status === 401 ||
    error.status === 403 ||
    codes.some((code) => AUTH_REFUSAL_CODE.test(code) || code === "FORBIDDEN")
  ) {
    return "auth";
  }
  if (error.status === 429 || codes.includes("RATE_LIMITED")) {
    return "rateLimited";
  }
  if (
    error.status === 0 ||
    error.status >= 500 ||
    codes.some((code) =>
      [
        "SERVER_UNREACHABLE",
        "TIMEOUT",
        "INTERNAL_ERROR",
        "UNSUPPORTED",
      ].includes(code)
    )
  ) {
    return "unavailable";
  }
  return "other";
}

/**
 * Returns the bearer token for MCPJam's API, read fresh for every request.
 *
 * For credentials that refresh — a CLI login's session token — where a value
 * captured once would expire mid-run. The client calls it before each mint,
 * each mint retry and each revoke, never caches what it returns, and never
 * sends it anywhere but MCPJam's own API.
 */
export type McpjamGetAuth = () => Promise<string>;

/**
 * An explicit MCPJam auth context: where the bearer comes from, and the extra
 * headers MCPJam's API requests carry. Bound to a lease scope (see
 * {@link McpjamModelLeaseScope}), so every lease minted in that scope is
 * minted as exactly this caller.
 */
export type McpjamAuthContext = {
  getAuth: McpjamGetAuth;
  /**
   * Extra headers for MCPJam API requests ONLY — mint and revoke, never the
   * model proxy, a model provider or an MCP server. `authorization` and
   * `content-type` are the client's and cannot be overridden here.
   */
  headers?: Readonly<Record<string, string>>;
};

export interface McpjamLeaseClientOptions {
  /** MCPJam app origin, e.g. `https://app.mcpjam.com`. */
  baseUrl: string;
  /**
   * An `sk_` organization API key, sent as-is on every platform request.
   * Exactly one of `apiKey` and `getAuth` is required.
   */
  apiKey?: string;
  /** A refreshed bearer, read per request — see {@link McpjamGetAuth}. */
  getAuth?: McpjamGetAuth;
  /** Extra MCPJam API headers — see {@link McpjamAuthContext.headers}. */
  headers?: Readonly<Record<string, string>>;
  /** Project id, or the `default` sentinel for the key org's Default project. */
  project: string;
  /** Canonical model id, e.g. `anthropic/claude-sonnet-4.5`. */
  model: string;
  fetchImpl?: typeof fetch;
}

/** Headers the client owns on a platform request; custom ones cannot replace them. */
const CLIENT_OWNED_HEADERS = new Set(["authorization", "content-type"]);

/**
 * Refuse an ambiguous credential. Two sources would make which identity a
 * lease is minted — and billed — as depend on precedence nobody wrote down.
 */
function assertOneCredentialSource(options: {
  apiKey?: string;
  getAuth?: McpjamGetAuth;
}): void {
  const hasKey = typeof options.apiKey === "string" && options.apiKey !== "";
  const hasCallback = typeof options.getAuth === "function";
  if (hasKey && hasCallback) {
    throw new Error(
      "MCPJam lease options carry both an API key and an auth callback; supply exactly one."
    );
  }
  if (!hasKey && !hasCallback) {
    throw new Error(
      "MCPJam lease options need an API key or an auth callback to mint with."
    );
  }
}

/**
 * The placeholder origin the AI SDK provider is built against.
 *
 * Deliberately not a real host: if the rewrite in `proxyFetch` ever failed to
 * fire, the request must not reach anything. A DNS failure at
 * `mcpjam-lease.invalid` is a loud, self-describing bug; a silent request to a
 * real origin carrying a prompt would not be.
 */
export const MCPJAM_PROXY_PLACEHOLDER_ORIGIN = "https://mcpjam-lease.invalid";

/**
 * The key the provider is constructed with, and which `proxyFetch` strips.
 *
 * The AI SDK providers require a non-empty key; the proxy authenticates with
 * the lease header instead. A recognizable sentinel means a value found on the
 * wire during debugging identifies itself rather than looking like a leak.
 */
export const MCPJAM_PLACEHOLDER_API_KEY = "mcpjam-lease-placeholder";

/** Re-mint this far ahead of expiry, so a long generation cannot straddle it. */
const RENEW_BEFORE_MS = 60_000;

/** Backoff for a lease at its in-flight ceiling (parallel iterations). */
const IN_FLIGHT_RETRY_DELAYS_MS = [250, 500, 1000];

function readEnvVar(name: string): string | undefined {
  // Guarded for the same reason `model-factory`'s copy is: this module is
  // reachable from entry points that must load where there is no `process`.
  if (typeof process === "undefined" || !process.env) return undefined;
  return process.env[name];
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

/** The MCPJam app origin to mint against. */
export function resolveMcpjamBaseUrl(explicit?: string): string {
  const raw =
    explicit ?? readEnvVar("MCPJAM_BASE_URL") ?? "https://app.mcpjam.com";
  return trimTrailingSlashes(raw);
}

/**
 * Which project pays. `default` is the server-side sentinel for the key org's
 * Default project — the same one `report-eval-results` uses, so inference and
 * results land in the same place with no configuration.
 */
export function resolveMcpjamProject(explicit?: string): string {
  return explicit ?? readEnvVar("MCPJAM_PROJECT_ID") ?? "default";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A caller may stop waiting without cancelling the mint shared by other calls.
function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal | null
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("MCPJam lease request timed out")),
    ms
  );
  try {
    return await abortable(operation(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Join the lease's proxy base with a vendor path, tolerating a `/v1` on either. */
function proxyUrlFor(proxyBaseUrl: string, pathname: string): string {
  // Anthropic leases hand back `…/model-proxy/anthropic`, OpenAI leases
  // `…/model-proxy/openai/v1` — the difference is the vendor's own path shape,
  // not something a caller should have to know. Normalize both to a base
  // WITHOUT `/v1` and let the provider's path supply it.
  const base = trimTrailingSlashes(proxyBaseUrl).replace(/\/v1$/, "");
  return `${base}${pathname}`;
}

async function readRetryAfterSeconds(
  response: Response
): Promise<number | undefined> {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Mints, renews and revokes one (org, project, model) lease, and exposes the
 * `fetch` that spends it.
 *
 * One client per model, shared across every iteration of a run: a lease covers
 * up to its call cap, so minting per request would burn the `sk_` key's rate
 * limit for nothing.
 */
export class McpjamLeaseClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly getAuth: McpjamGetAuth | undefined;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly project: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  private current: McpjamModelLease | null = null;
  private readonly held = new Map<string, McpjamModelLease>();
  private readonly inFlight = new Map<string, number>();
  private readonly revoking = new Map<string, Promise<void>>();
  /**
   * The in-flight mint, so concurrent iterations share ONE call. Without it a
   * suite that runs 20 cases in parallel mints 20 leases on its first tick —
   * every one of them counting against the active-lease cap and the API key's
   * rate limit.
   */
  private minting: Promise<McpjamModelLease> | null = null;

  constructor(options: McpjamLeaseClientOptions) {
    assertOneCredentialSource(options);
    this.baseUrl = trimTrailingSlashes(options.baseUrl);
    this.apiKey = options.getAuth ? undefined : options.apiKey;
    this.getAuth = options.getAuth;
    this.extraHeaders = { ...(options.headers ?? {}) };
    this.project = options.project;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.proxyFetch = this.proxyFetch.bind(this);
  }

  /**
   * The headers for ONE request to MCPJam's own API, credential read now.
   *
   * Custom headers first, minus any spelling of the two the client owns,
   * then those two — so a custom `Authorization` can never survive. A plain
   * record, as the requests have always sent. A callback that fails is a
   * credential failure, reported as one.
   */
  private async platformHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.extraHeaders)) {
      if (CLIENT_OWNED_HEADERS.has(name.toLowerCase())) continue;
      headers[name] = value;
    }
    let token: string;
    if (this.getAuth) {
      try {
        token = await this.getAuth();
      } catch (error) {
        throw new McpjamLeaseError(
          `Could not read MCPJam credentials: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { code: "AUTH_UNAVAILABLE", status: 0 }
        );
      }
      if (typeof token !== "string" || token.trim() === "") {
        throw new McpjamLeaseError(
          "MCPJam credentials resolved to an empty token",
          { code: "AUTH_UNAVAILABLE", status: 0 }
        );
      }
    } else {
      token = this.apiKey ?? "";
    }
    headers["content-type"] = "application/json";
    headers.authorization = `Bearer ${token}`;
    return headers;
  }

  /** The live lease, minting or renewing if needed. */
  async getLease(signal?: AbortSignal | null): Promise<McpjamModelLease> {
    signal?.throwIfAborted();
    const live = this.current;
    if (live && live.expiresAt - Date.now() > RENEW_BEFORE_MS) return live;
    if (this.minting) return abortable(this.minting, signal);

    this.current = null;
    this.minting = withDeadline(async (signal) => {
      // Return unused slots before asking for another lease at the active cap.
      await this.revokeUnused();
      signal.throwIfAborted();
      return this.mint(signal);
    }, 15_000).finally(() => {
      this.minting = null;
    });
    return abortable(this.minting, signal);
  }

  /** Forget the cached lease, so the next call mints a fresh one. */
  invalidate(expected = this.current): void {
    if (this.current === expected) this.current = null;
  }

  /**
   * Revoke the lease, best effort.
   *
   * Leases expire on their own, so a failure here costs nothing — it is worth
   * doing at suite teardown only because it returns the slot to the org's
   * active-lease budget immediately rather than in half an hour.
   */
  async revoke(): Promise<void> {
    // A mint already in progress may return after teardown begins.
    await this.minting?.catch(() => {});
    this.current = null;
    await Promise.all(
      [...this.held.values()].map((lease) => this.revokeLease(lease))
    );
  }

  private async revokeLease(lease: McpjamModelLease): Promise<void> {
    const pending = this.revoking.get(lease.runId);
    if (pending) return pending;
    const revoke = withDeadline(async (signal) => {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/v1/projects/${encodeURIComponent(this.project)}/model-leases/revoke`,
        {
          method: "POST",
          headers: await this.platformHeaders(),
          body: JSON.stringify({ runId: lease.runId }),
          signal,
        }
      );
      if (response.ok) this.held.delete(lease.runId);
    }, 5_000)
      .catch(() => {})
      .finally(() => this.revoking.delete(lease.runId));
    this.revoking.set(lease.runId, revoke);
    return revoke;
  }

  private async revokeUnused(): Promise<void> {
    await Promise.all(
      [...this.held.values()]
        .filter(
          (lease) => lease !== this.current && !this.inFlight.get(lease.runId)
        )
        .map((lease) => this.revokeLease(lease))
    );
  }

  private async mint(signal: AbortSignal): Promise<McpjamModelLease> {
    const url = `${this.baseUrl}/api/v1/projects/${encodeURIComponent(this.project)}/model-leases`;
    // Headers are rebuilt per send: a refreshed credential is read again for
    // the retry rather than reusing one that may have just expired.
    const send = async () =>
      this.fetchImpl(url, {
        method: "POST",
        headers: await this.platformHeaders(),
        body: JSON.stringify({ model: this.model }),
        signal,
      });

    let response = await send();
    // ONE retry on a rate limit, honoring the server's own delay. The `sk_`
    // key is metered per key, and a sharded CI run can crowd itself on the
    // first tick; anything past one retry is a real refusal to surface.
    if (response.status === 429) {
      const wait = await readRetryAfterSeconds(response);
      await abortable(sleep(Math.min((wait ?? 1) * 1000, 5_000)), signal);
      response = await send();
    }

    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      const retryAfterSeconds = await readRetryAfterSeconds(response);
      const details =
        body?.details &&
        typeof body.details === "object" &&
        !Array.isArray(body.details)
          ? (body.details as Record<string, unknown>)
          : undefined;
      throw new McpjamLeaseError(
        typeof body?.message === "string"
          ? body.message
          : typeof body?.error === "string"
            ? body.error
            : `MCPJam refused a model lease for ${this.model}`,
        {
          ...(typeof body?.code === "string" ? { code: body.code } : {}),
          status: response.status,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
          ...(details ? { details } : {}),
        }
      );
    }
    if (
      typeof body?.lease !== "string" ||
      typeof body?.proxyBaseUrl !== "string" ||
      typeof body?.expiresAt !== "number" ||
      typeof body?.runId !== "string" ||
      (body?.protocol !== "anthropic" && body?.protocol !== "openai")
    ) {
      // Fail loudly rather than keep a half-built lease: a missing field would
      // otherwise surface as an unauthenticated proxy call.
      throw new McpjamLeaseError(
        `MCPJam returned an unrecognized lease for ${this.model}`,
        { code: "UNSUPPORTED", status: response.status }
      );
    }

    const lease: McpjamModelLease = {
      lease: body.lease,
      protocol: body.protocol,
      proxyBaseUrl: body.proxyBaseUrl,
      expiresAt: body.expiresAt,
      runId: body.runId,
    };
    signal.throwIfAborted();
    this.held.set(lease.runId, lease);
    this.current = lease;
    return lease;
  }

  /**
   * The `fetch` the AI SDK provider is built with.
   *
   * Rewrites the placeholder URL to the live proxy, swaps the placeholder
   * credential for the lease header, and re-mints when the lease is the reason
   * a call was refused.
   */
  async proxyFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const requested = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    );

    const attempt = async (lease: McpjamModelLease): Promise<Response> => {
      const headers = new Headers(init?.headers);
      // The provider set one of these to the placeholder key. Delete BOTH so
      // no credential-shaped header reaches the proxy, whichever vendor's
      // provider built this request.
      headers.delete("authorization");
      headers.delete("x-api-key");
      headers.set("x-mcpjam-harness-lease", lease.lease);
      init?.signal?.throwIfAborted();
      this.inFlight.set(lease.runId, (this.inFlight.get(lease.runId) ?? 0) + 1);
      try {
        return await this.fetchImpl(
          proxyUrlFor(lease.proxyBaseUrl, requested.pathname) +
            requested.search,
          { ...init, headers }
        );
      } finally {
        const remaining = (this.inFlight.get(lease.runId) ?? 1) - 1;
        if (remaining) this.inFlight.set(lease.runId, remaining);
        else this.inFlight.delete(lease.runId);
      }
    };

    try {
      let lease = await this.getLease(init?.signal);
      let response = await attempt(lease);

      // A retry has to re-send the body, so it is only safe when the body is a
      // string — which is what the AI SDK sends. A stream would already be
      // consumed, so leave those refusals to the caller.
      const replayable = typeof init?.body === "string" || init?.body == null;
      if (!replayable || response.ok) return response;

      const reason = await peekLeaseRefusal(response);
      if (reason === "stale") {
        // Revoked, expired, or spent — a fresh lease is a fresh envelope. The
        // org's own spend cap still binds on every generation, so this cannot
        // turn a spending refusal into unlimited spending.
        this.invalidate(lease);
        lease = await this.getLease(init?.signal);
        return await attempt(lease);
      }
      if (reason === "in_flight") {
        // This lease's parallel-generation ceiling, not a spending problem —
        // re-minting would burn a lease slot for something that clears on its
        // own in milliseconds.
        for (const delay of IN_FLIGHT_RETRY_DELAYS_MS) {
          await abortable(sleep(delay), init?.signal);
          response = await attempt(lease);
          if (
            response.ok ||
            (await peekLeaseRefusal(response)) !== "in_flight"
          ) {
            return response;
          }
        }
      }
      return response;
    } finally {
      await this.revokeUnused();
    }
  }
}

/**
 * Was this refusal about the LEASE, and which kind?
 *
 * The proxy answers `{ok: false, error}` with the reason in prose. Reading it
 * is what separates "your lease is used up" (re-mint) from "too many at once"
 * (wait) from "your organization is out of credits" (surface it — retrying
 * would just spend the rate limit and report the wrong problem).
 */
async function peekLeaseRefusal(
  response: Response
): Promise<"stale" | "in_flight" | null> {
  if (
    response.status !== 401 &&
    response.status !== 403 &&
    response.status !== 429
  ) {
    return null;
  }
  let error = "";
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    error = typeof body?.error === "string" ? body.error : "";
  } catch {
    return null;
  }
  if (/max_in_flight/i.test(error)) return "in_flight";
  if (/budget_exhausted|max_calls/i.test(error)) return "stale";
  if (response.status === 429) return null;
  return /lease/i.test(error) ? "stale" : null;
}

/**
 * One client per (deployment, project, model, credential), so every iteration
 * of a run shares a lease.
 *
 * A suite shares this scope across its iteration clones and releases only
 * these clients at teardown. Standalone runners share the default scope.
 *
 * A scope may be BOUND to one explicit {@link McpjamAuthContext}: a run that
 * mints as a logged-in user binds its scope to that user's auth context, every
 * `mcpjam/…` model built against the scope mints through it, and releasing the
 * scope revokes exactly those leases — never another caller's. Clients are
 * keyed by deployment, project and model within that context; an auth
 * callback is an identity, never serialized into a key, so two contexts can
 * never collapse onto one client.
 */
export class McpjamModelLeaseScope {
  private readonly clients = new Map<string, McpjamLeaseClient>();
  /** Clients minted with a callback, per callback identity. */
  private authClients = new WeakMap<
    McpjamGetAuth,
    Map<string, McpjamLeaseClient>
  >();
  /** Every client this scope created, so `release` can reach all of them. */
  private readonly all = new Set<McpjamLeaseClient>();
  /** The auth context this scope is bound to, if any. */
  readonly auth?: McpjamAuthContext;

  constructor(options: { auth?: McpjamAuthContext } = {}) {
    if (options.auth) {
      if (typeof options.auth.getAuth !== "function") {
        throw new Error(
          "A lease scope's auth context needs a getAuth callback."
        );
      }
      this.auth = {
        getAuth: options.auth.getAuth,
        ...(options.auth.headers
          ? { headers: Object.freeze({ ...options.auth.headers }) }
          : {}),
      };
    }
  }

  getClient(options: McpjamLeaseClientOptions): McpjamLeaseClient {
    assertOneCredentialSource(options);
    const headersKey = options.headers
      ? Object.entries(options.headers).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        )
      : [];

    if (options.getAuth) {
      if (this.auth && options.getAuth !== this.auth.getAuth) {
        throw new Error(
          "This lease scope is bound to a different MCPJam auth context."
        );
      }
      let byKey = this.authClients.get(options.getAuth);
      if (!byKey) {
        byKey = new Map();
        this.authClients.set(options.getAuth, byKey);
      }
      const key = JSON.stringify([
        options.baseUrl,
        options.project,
        options.model,
        headersKey,
      ]);
      let client = byKey.get(key);
      if (!client) {
        client = new McpjamLeaseClient(options);
        byKey.set(key, client);
        this.all.add(client);
      }
      return client;
    }

    if (this.auth) {
      throw new Error(
        "This lease scope is bound to an MCPJam auth context and does not mint with a fixed API key."
      );
    }
    const key = JSON.stringify([
      options.baseUrl,
      options.project,
      options.model,
      options.apiKey,
      ...(headersKey.length > 0 ? [headersKey] : []),
    ]);
    let client = this.clients.get(key);
    if (!client) {
      client = new McpjamLeaseClient(options);
      this.clients.set(key, client);
      this.all.add(client);
    }
    return client;
  }

  async release(): Promise<void> {
    const held = [...this.all];
    this.all.clear();
    this.clients.clear();
    // A WeakMap cannot be cleared; a fresh one forgets every callback's
    // clients, so the next `getClient` after a release mints anew.
    this.authClients = new WeakMap();
    await Promise.all(held.map((client) => client.revoke()));
  }
}

const defaultScope = new McpjamModelLeaseScope();

export function getMcpjamLeaseClient(
  options: McpjamLeaseClientOptions,
  scope = defaultScope
): McpjamLeaseClient {
  return scope.getClient(options);
}

/** Release leases made outside an EvalSuite; suites own independent scopes. */
export async function releaseMcpjamModelLeases(): Promise<void> {
  await defaultScope.release();
}
