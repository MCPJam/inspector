import {
  DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  createOAuthStateMachine,
  getBrowserDebugDynamicRegistrationMetadata,
  isLoopbackOAuthUrl,
  type OAuthFlowState,
  type OAuthProtocolVersion,
  type OAuthRequestExecutor,
  type RegistrationStrategy2025_03_26,
  type RegistrationStrategy2025_06_18,
  type RegistrationStrategy2025_11_25,
} from "@mcpjam/sdk/browser";
import { authFetch } from "@/lib/session-token";
import { reportCaught } from "@/lib/error-reporting";
import { HOSTED_MODE } from "@/lib/config";
import { tryResolveProjectServer } from "@/lib/apis/web/context";
import { fetchOAuthClientSecret } from "@/lib/apis/hosted-oauth-client-secret-api";

type OAuthRegistrationStrategy =
  | RegistrationStrategy2025_03_26
  | RegistrationStrategy2025_06_18
  | RegistrationStrategy2025_11_25;

export interface InspectorOAuthStateMachineConfig {
  protocolVersion: OAuthProtocolVersion;
  registrationStrategy: OAuthRegistrationStrategy;
  state: OAuthFlowState;
  getState?: () => OAuthFlowState;
  updateState: (updates: Partial<OAuthFlowState>) => void;
  serverUrl: string;
  serverName: string;
  customScopes?: string;
  customHeaders?: Record<string, string>;
  /**
   * Opt-in: accept a path-scoped authorization server whose metadata
   * advertises the same-origin root as issuer (multi-tenant AS deployments
   * like Scalekit). Off = strict RFC 8414 issuer match.
   */
  allowPathScopedIssuer?: boolean;
  /**
   * Credentials the user configured on the OAuth test profile ("Configure
   * Server to Test" → Client credentials). Secrets are never written to
   * localStorage, so they can only reach the state machine through here —
   * the stored `mcp-client-*` record is a clientId-only fallback. An explicit
   * secret takes precedence over the Convex-backed fetch below.
   */
  preregisteredClientId?: string;
  preregisteredClientSecret?: string;
  /**
   * Whether a client secret is stored in Convex for this server. Since #2758
   * secrets no longer live in browser storage, so the debugger must fetch the
   * secret at token-exchange time (mirroring the connect flow's
   * `MCPOAuthProvider.loadStoredClientSecret`).
   */
  hasClientSecret?: boolean;
}

function normalizeResponseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function serializeProxyBody(
  body: unknown,
  headers: Record<string, string>,
): unknown {
  if (body === undefined || body === null) {
    return undefined;
  }

  const contentType =
    Object.entries(headers).find(
      ([key]) => key.toLowerCase() === "content-type",
    )?.[1] ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params =
      typeof body === "string"
        ? new URLSearchParams(body)
        : new URLSearchParams();
    return Object.fromEntries(params.entries());
  }

  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  return body;
}

/**
 * The proxy route answers a failure with `{ error }` naming the guard that
 * rejected the request — unresolvable host, private/reserved address, timeout,
 * redirect cap. Dropping it leaves the flow log (and Sentry) with a bare status
 * line that says nothing about which one fired.
 */
async function readProxyError(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => "");
  if (!text) return undefined;
  try {
    const body = JSON.parse(text) as {
      message?: string;
      error?: string;
    } | null;
    const message = body?.message ?? body?.error;
    if (typeof message === "string" && message) return message;
  } catch {
    // Not JSON — a reverse proxy or dev-server error page. Fall through to the
    // raw text, capped so an HTML document cannot become the error message.
  }
  return text.slice(0, 300);
}

export function createDebugRequestExecutor(): OAuthRequestExecutor {
  return async (request) => {
    const debugProxyPath = HOSTED_MODE
      ? "/api/web/oauth/debug/proxy"
      : "/api/mcp/oauth/debug/proxy";

    const proxyResponse = await authFetch(debugProxyPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: request.url,
        method: request.method,
        headers: {
          Accept: "application/json, text/event-stream",
          ...request.headers,
        },
        body: serializeProxyBody(request.body, request.headers),
        ...(request.redirect ? { redirect: request.redirect } : {}),
      }),
    });

    if (!proxyResponse.ok) {
      const reason = await readProxyError(proxyResponse);
      throw new Error(
        `Backend debug proxy error: ${proxyResponse.status} ${proxyResponse.statusText}${
          reason ? `: ${reason}` : ""
        }`,
      );
    }

    const data = await proxyResponse.json();
    return {
      status: data.status,
      statusText: data.statusText,
      headers: normalizeResponseHeaders(data.headers ?? {}),
      body: data.body,
      ok: data.status >= 200 && data.status < 300,
    };
  };
}

export function getDebugRedirectUrl(): string {
  return `${window.location.origin}/oauth/callback/debug`;
}

export function loadDebugPreregisteredCredentials({
  serverName,
}: {
  serverName: string;
  serverUrl: string;
}): {
  clientId?: string;
} {
  try {
    const storedClientInfo = localStorage.getItem(`mcp-client-${serverName}`);
    if (!storedClientInfo) {
      return {};
    }

    const parsed = JSON.parse(storedClientInfo);
    if (parsed && typeof parsed === "object" && "client_secret" in parsed) {
      localStorage.setItem(
        `mcp-client-${serverName}`,
        JSON.stringify({ client_id: parsed.client_id || undefined }),
      );
    }
    return {
      clientId: parsed.client_id || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Resolve the Convex-backed client secret for the debugger flow. When the
 * server has a stored secret, fetch it lazily and memoize the promise so a
 * single flow (initial exchange + any fallback retry) fetches once. The
 * secret is only ever held in machine memory — never written to localStorage —
 * preserving the #2758 "no secrets in browser storage" guarantee. An explicit
 * profile secret short-circuits this resolver at the call site.
 */
function createHostedClientSecretResolver({
  serverName,
  hasClientSecret,
}: Pick<
  InspectorOAuthStateMachineConfig,
  "serverName" | "hasClientSecret"
>): () => Promise<string | undefined> {
  let pending: Promise<string | undefined> | undefined;

  return () => {
    if (!hasClientSecret) {
      return Promise.resolve(undefined);
    }
    if (!pending) {
      const resolved = tryResolveProjectServer(serverName);
      if (!resolved) {
        return Promise.resolve(undefined);
      }
      pending = fetchOAuthClientSecret({
        projectId: resolved.projectId,
        serverId: resolved.serverId,
      })
        .then((result) => result.clientSecret)
        .catch(() => {
          // Degrade to an unauthenticated token request rather than aborting
          // the flow; the resulting 401 stays visible in the HTTP history.
          // Clear the memo so a later retry can re-attempt the fetch.
          pending = undefined;
          return undefined;
        });
    }
    return pending;
  };
}

/**
 * Wrap the caller's `updateState` so every NEW step failure is reported.
 *
 * This is the only reliable hook: the SDK state machine catches its own step
 * errors internally and never rethrows — it writes the message into flow state
 * and returns normally. Without this, a debugger step that failed for everyone
 * (a broken metadata fetch, a 401 exchange) produced no signal at all outside
 * the user's own screen.
 *
 * `warning` level, not `error`: many of these are the server-under-test
 * misbehaving, which is exactly what a debugger is for. The value is the
 * aggregate trend, not a page.
 */
/**
 * Bound the untrusted text before it leaves the browser.
 *
 * These strings come from the server UNDER TEST — an `error_description` is
 * whatever that server chose to return, and the debugger is routinely pointed
 * at half-built servers that echo request context back into error bodies. A
 * diagnostic signal must not become an exfiltration path, so every shape a
 * credential plausibly arrives in gets redacted before capture:
 *
 *   1. URL userinfo, with or without a scheme (`https://u:p@h`, `u:p@h`)
 *   2. credential-ish query/form parameters, by name
 *   3. `Authorization: Bearer|Basic <value>` echoed from a request
 *   4. JSON credential fields (`"client_secret": "..."`)
 *
 * Then a length cap, because an upstream body can be arbitrarily large.
 *
 * Deliberately over-redacts: losing a token's value costs nothing here (the
 * parameter NAME is the diagnostic), while leaking one is unrecoverable.
 */
const CREDENTIAL_PARAM_NAMES =
  "client_secret|access_token|refresh_token|id_token|code_verifier|code|assertion|password|api[-_]?key|token|secret";

/** Final length of a reported message. */
const MAX_REPORTED = 500;

/**
 * How much raw input the redactors are allowed to scan.
 *
 * The cap has to come BEFORE the replace chain — an upstream body can be
 * megabytes, and four global regexes over it would copy the whole thing four
 * times on a render path. It is deliberately wider than `MAX_REPORTED` so the
 * redactors still see the context around anything that survives to the output.
 */
const MAX_SCANNED = 4_000;

export function sanitizeStepError(message: string): string {
  const truncated = message.length > MAX_SCANNED;
  const bounded = truncated ? message.slice(0, MAX_SCANNED) : message;

  const redacted = bounded
    // 1a. scheme://user:pass@host. Greedy up to the LAST `@` of the
    // authority: `@` is legal inside a password, so
    // `https://user:secret@part@host` has userinfo `user:secret@part`, and
    // stopping at the first `@` would report half the password.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1[redacted]@")
    // 1b. bare user:pass@host (no scheme), same greediness.
    .replace(/(^|[\s(<"'])[^\s/@:]+:[^\s/]+@(?=[\w.-]+)/g, "$1[redacted]@")
    // 2. ?client_secret=… / &token=…
    .replace(
      new RegExp(`\\b(${CREDENTIAL_PARAM_NAMES})=[^&\\s"'<>]+`, "gi"),
      "$1=[redacted]",
    )
    // 3a. An echoed `Authorization:` header — redact whatever follows.
    .replace(
      /\b((?:proxy-)?authorization\s*[:=]\s*)(bearer|basic)\s+\S+/gi,
      "$1$2 [redacted]",
    )
    // 3b. A bare `Bearer <value>` with no header context. This one must only
    // fire on a credential-SHAPED value: `\b(bearer|basic)\s+\w+` turns the
    // very common "Bearer token is expired" into "Bearer [redacted] is
    // expired", destroying the diagnostic word this function promises to keep.
    // Real values carry base64url/JWT punctuation or are simply long.
    .replace(
      /\b(bearer|basic)\s+(?:[\w-]*[._~+/=][\w\-._~+/=]*|\w{20,})/gi,
      "$1 [redacted]",
    )
    // 4. "client_secret": "…" — `(?:\\.|[^"\\])*` rather than `[^"]*`, or an
    // escaped quote inside the value ends the match early and leaves the
    // secret's tail in the report.
    .replace(
      new RegExp(
        `("(?:${CREDENTIAL_PARAM_NAMES})"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`,
        "gi",
      ),
      '$1"[redacted]"',
    );

  // Patterns 1b/2/3 all match to end-of-string, so a value the cap cut in half
  // is still redacted. The JSON and scheme-userinfo forms need a closing
  // delimiter, so cutting mid-value would leave a raw prefix — close those two
  // here, and only when the cap actually fired, so an ordinary message that
  // merely ends in a URL keeps its hostname.
  const tailGuarded = truncated
    ? redacted
        .replace(
          // Escape-aware like the terminated form above, or an unterminated
          // value containing `\\"` stops the match at that quote and leaks its
          // tail. `[\\s\\S]?` so a trailing backslash at the cut still matches.
          new RegExp(
            `("(?:${CREDENTIAL_PARAM_NAMES})"\\s*:\\s*)"(?:\\\\[\\s\\S]?|[^"\\\\])*$`,
            "gi",
          ),
          '$1"[redacted]',
        )
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*$/gi, "$1[redacted]")
    : redacted;

  return tailGuarded.slice(0, MAX_REPORTED);
}

function withStepFailureReporting(
  updateState: InspectorOAuthStateMachineConfig["updateState"],
  context: { protocolVersion: OAuthProtocolVersion; getStep: () => string },
): InspectorOAuthStateMachineConfig["updateState"] {
  let lastReportedError: string | undefined;

  return (updates) => {
    const error = updates.error;
    if (typeof error === "string" && error !== "" && error !== lastReportedError) {
      lastReportedError = error;
      reportCaught(new Error(sanitizeStepError(error)), {
        source: "oauth_debugger_step",
        level: "warning",
        extra: {
          // Prefer the step this update is moving TO. An update that both
          // advances the step and carries an error would otherwise be
          // attributed to the PREVIOUS step, making the dimension misleading.
          step:
            (updates as { currentStep?: string }).currentStep ??
            context.getStep(),
          protocolVersion: context.protocolVersion,
        },
      });
    } else if (!error && "error" in updates) {
      // Cleared: the next occurrence of the same message is a new failure.
      lastReportedError = undefined;
    }
    updateState(updates);
  };
}

export function createInspectorOAuthStateMachine(
  config: InspectorOAuthStateMachineConfig,
) {
  const {
    preregisteredClientId,
    preregisteredClientSecret,
    hasClientSecret,
    ...machineConfig
  } = config;
  // Preserve the exact typed secret — trimming would silently change one
  // that legitimately has leading/trailing whitespace before it's used to
  // authenticate the live token exchange below.
  const explicitClientSecret = preregisteredClientSecret?.trim()
    ? preregisteredClientSecret
    : undefined;
  const resolveHostedClientSecret = createHostedClientSecretResolver(config);

  return createOAuthStateMachine({
    ...machineConfig,
    updateState: withStepFailureReporting(config.updateState, {
      protocolVersion: config.protocolVersion,
      getStep: () =>
        (config.getState?.() ?? config.state).currentStep ?? "unknown",
    }),
    hasClientSecret: Boolean(explicitClientSecret) || Boolean(hasClientSecret),
    redirectUrl: getDebugRedirectUrl(),
    requestExecutor: createDebugRequestExecutor(),
    // The debugger is a local-dev inspection surface: when the server under
    // test is itself loopback (e.g. a `127.0.0.1` dev MCP server), its metadata
    // fetches must be permitted. Mirror the Connect flow — allow loopback only
    // when the debugged server URL is loopback; the guard still blocks
    // LAN/link-local/reserved destinations regardless.
    allowLoopbackMetadataFetch: isLoopbackOAuthUrl(machineConfig.serverUrl),
    // One step per "Continue" click: `scheduleAutoAdvance` is intentionally not
    // provided. The SDK state machines call it via optional chaining, so when
    // it is absent each `proceedToNextStep()` stops at the next step instead of
    // chaining a prepare → send → receive burst (or the multi-hop CIMD
    // sequence) on a single click. This lets users inspect every request and
    // response individually — the "prepare" stop even shows the pending request
    // before it is sent. To restore bundled stepping, schedule `fn` on a timer
    // here again, e.g. `scheduleAutoAdvance: (fn, delayMs) => window.setTimeout(fn, delayMs)`.
    // Profile credentials are authoritative when configured: the stored
    // `mcp-client-*` record can hold a stale DCR-registered client id, and it
    // never holds a secret — without the explicit secret the machine resolves
    // the token auth method as "none" and the exchange 401s (#3029). Pairing
    // a profile secret with a stored client id would authenticate as the
    // wrong client, so the stored record is only consulted when the profile
    // has no credentials at all. The Convex-backed secret, by contrast, may
    // pair with either id source — it belongs to the synced server record,
    // mirroring the Connect flow's stored-info + fetched-secret merge.
    loadPreregisteredCredentials: async (input) => {
      if (preregisteredClientId || explicitClientSecret) {
        return {
          clientId: preregisteredClientId,
          clientSecret:
            explicitClientSecret ?? (await resolveHostedClientSecret()),
        };
      }
      return {
        ...loadDebugPreregisteredCredentials(input),
        clientSecret: await resolveHostedClientSecret(),
      };
    },
    dynamicRegistration: getBrowserDebugDynamicRegistrationMetadata(
      config.protocolVersion,
    ),
    clientIdMetadataUrl: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  });
}
