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

  constructor(
    message: string,
    options: { code?: string; status: number; retryAfterSeconds?: number }
  ) {
    super(message);
    this.name = "McpjamLeaseError";
    this.code = options.code ?? "UNKNOWN";
    this.status = options.status;
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

export interface McpjamLeaseClientOptions {
  /** MCPJam app origin, e.g. `https://app.mcpjam.com`. */
  baseUrl: string;
  /** An `sk_` organization API key. */
  apiKey: string;
  /** Project id, or the `default` sentinel for the key org's Default project. */
  project: string;
  /** Canonical model id, e.g. `anthropic/claude-sonnet-4.5`. */
  model: string;
  fetchImpl?: typeof fetch;
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

/** The MCPJam app origin to mint against. */
export function resolveMcpjamBaseUrl(explicit?: string): string {
  const raw =
    explicit ?? readEnvVar("MCPJAM_BASE_URL") ?? "https://app.mcpjam.com";
  return raw.replace(/\/+$/, "");
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

/** Join the lease's proxy base with a vendor path, tolerating a `/v1` on either. */
function proxyUrlFor(proxyBaseUrl: string, pathname: string): string {
  // Anthropic leases hand back `…/model-proxy/anthropic`, OpenAI leases
  // `…/model-proxy/openai/v1` — the difference is the vendor's own path shape,
  // not something a caller should have to know. Normalize both to a base
  // WITHOUT `/v1` and let the provider's path supply it.
  const base = proxyBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
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
  private readonly apiKey: string;
  private readonly project: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  private current: McpjamModelLease | null = null;
  /**
   * The in-flight mint, so concurrent iterations share ONE call. Without it a
   * suite that runs 20 cases in parallel mints 20 leases on its first tick —
   * every one of them counting against the active-lease cap and the API key's
   * rate limit.
   */
  private minting: Promise<McpjamModelLease> | null = null;

  constructor(options: McpjamLeaseClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.project = options.project;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.proxyFetch = this.proxyFetch.bind(this);
  }

  /** The live lease, minting or renewing if needed. */
  async getLease(): Promise<McpjamModelLease> {
    const live = this.current;
    if (live && live.expiresAt - Date.now() > RENEW_BEFORE_MS) return live;
    if (this.minting) return this.minting;

    this.minting = this.mint().finally(() => {
      this.minting = null;
    });
    return this.minting;
  }

  /** Forget the cached lease, so the next call mints a fresh one. */
  invalidate(): void {
    this.current = null;
  }

  /**
   * Revoke the lease, best effort.
   *
   * Leases expire on their own, so a failure here costs nothing — it is worth
   * doing at suite teardown only because it returns the slot to the org's
   * active-lease budget immediately rather than in half an hour.
   */
  async revoke(): Promise<void> {
    const live = this.current;
    this.current = null;
    if (!live) return;
    try {
      await this.fetchImpl(
        `${this.baseUrl}/api/v1/projects/${encodeURIComponent(this.project)}/model-leases/revoke`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ runId: live.runId }),
        }
      );
    } catch {
      // Teardown must not fail a run that already produced its results.
    }
  }

  private async mint(): Promise<McpjamModelLease> {
    const url = `${this.baseUrl}/api/v1/projects/${encodeURIComponent(this.project)}/model-leases`;
    const send = () =>
      this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model }),
      });

    let response = await send();
    // ONE retry on a rate limit, honoring the server's own delay. The `sk_`
    // key is metered per key, and a sharded CI run can crowd itself on the
    // first tick; anything past one retry is a real refusal to surface.
    if (response.status === 429) {
      const wait = await readRetryAfterSeconds(response);
      await sleep(Math.min((wait ?? 1) * 1000, 5_000));
      response = await send();
    }

    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      const retryAfterSeconds = await readRetryAfterSeconds(response);
      throw new McpjamLeaseError(
        typeof body?.message === "string"
          ? body.message
          : `MCPJam refused a model lease for ${this.model}`,
        {
          ...(typeof body?.code === "string" ? { code: body.code } : {}),
          status: response.status,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
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
      return this.fetchImpl(
        proxyUrlFor(lease.proxyBaseUrl, requested.pathname) + requested.search,
        { ...init, headers }
      );
    };

    let lease = await this.getLease();
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
      this.invalidate();
      lease = await this.getLease();
      return attempt(lease);
    }
    if (reason === "in_flight") {
      // This lease's parallel-generation ceiling, not a spending problem —
      // re-minting would burn a lease slot for something that clears on its
      // own in milliseconds.
      for (const delay of IN_FLIGHT_RETRY_DELAYS_MS) {
        await sleep(delay);
        response = await attempt(lease);
        if (response.ok || (await peekLeaseRefusal(response)) !== "in_flight") {
          return response;
        }
      }
    }
    return response;
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
 * One client per (deployment, project, model, key), so every iteration of a run
 * shares a lease.
 *
 * Module-level rather than per-`HostRunner`: a vitest file constructs a runner
 * per case, and a lease per case would multiply both the mint traffic and the
 * active-lease count by the size of the suite.
 */
const clients = new Map<string, McpjamLeaseClient>();

export function getMcpjamLeaseClient(
  options: McpjamLeaseClientOptions
): McpjamLeaseClient {
  // The key ends with a SUFFIX of the API key, never the key: enough to keep
  // two credentials' clients apart, not enough to leak one into a heap dump or
  // an error message.
  const cacheKey = [
    options.baseUrl,
    options.project,
    options.model,
    options.apiKey.slice(-6),
  ].join("|");
  const existing = clients.get(cacheKey);
  if (existing) return existing;
  const created = new McpjamLeaseClient(options);
  clients.set(cacheKey, created);
  return created;
}

/**
 * Revoke every lease this process holds, and forget them.
 *
 * `EvalSuite.run` calls this at teardown. Safe to call directly — from a
 * vitest `afterAll`, say — and safe to call when there is nothing to revoke.
 */
export async function releaseMcpjamModelLeases(): Promise<void> {
  const held = [...clients.values()];
  clients.clear();
  await Promise.all(held.map((client) => client.revoke()));
}
