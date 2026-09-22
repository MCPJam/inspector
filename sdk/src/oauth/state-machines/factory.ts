/**
 * Factory for creating protocol-specific OAuth state machines
 *
 * This factory selects the appropriate state machine implementation
 * based on the protocol version specified in the configuration.
 */

import type {
  OAuthStateMachine,
  OAuthProtocolVersion,
  BaseOAuthStateMachineConfig,
  OAuthHttpRequest,
  OAuthRequestExecutor,
  OAuthRequestResult,
  RegistrationStrategy2025_03_26,
  RegistrationStrategy2025_06_18,
  RegistrationStrategy2025_11_25,
  RegistrationStrategy2026_07_28,
} from "./types.js";
import { assertOutboundOAuthUrlAllowed } from "../ssrf-guard.js";
import { applyEmulationUserAgent } from "./shared/emulation.js";

import {
  createDebugOAuthStateMachine as create2025_03_26,
  type DebugOAuthStateMachineConfig as Config2025_03_26,
} from "./debug-oauth-2025-03-26.js";

import {
  createDebugOAuthStateMachine as create2025_06_18,
  type DebugOAuthStateMachineConfig as Config2025_06_18,
} from "./debug-oauth-2025-06-18.js";

import {
  createDebugOAuthStateMachine as create2025_11_25,
  type DebugOAuthStateMachineConfig as Config2025_11_25,
} from "./debug-oauth-2025-11-25.js";

import {
  createDebugOAuthStateMachine as create2026_07_28,
  type DebugOAuthStateMachineConfig as Config2026_07_28,
} from "./debug-oauth-2026-07-28.js";
import { protocolVersionLabel } from "../../mcp-client-manager/mcp-protocol-version.js";

/**
 * A redaction sentinel reached the state machine as a live credential.
 *
 * Distinct error type so a caller can tell "MCPJam redacted its own live data"
 * apart from an authorization-server failure — the two look identical from the
 * outside (both end in `401 invalid_token`) and that is precisely what made
 * #3865 expensive to diagnose.
 */
export class OAuthRedactedCredentialError extends Error {
  readonly field: string;

  constructor(field: string, target: string) {
    super(
      `OAuth response from ${target} carried a redacted \`${field}\`. ` +
        "Trace redaction was applied to data the OAuth flow consumes; a " +
        "redaction sentinel is a non-empty string, so it would be sent " +
        "upstream as a credential and rejected as invalid. Redaction belongs " +
        "to the trace projection layer only.",
    );
    this.name = "OAuthRedactedCredentialError";
    this.field = field;
  }
}

/**
 * Top-level credential fields the flow consumes verbatim. A sentinel in any of
 * these is used as a credential rather than merely displayed.
 */
const CONSUMED_CREDENTIAL_FIELDS = [
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
] as const;

/**
 * The sentinel shapes this codebase's redactors emit: the bare marker, and the
 * `redactSensitiveTraceValue` truncation form `abcd...[redacted]...yz`.
 *
 * Deliberately narrow. An opaque token is an arbitrary string, so a loose match
 * would fail real logins — the guard must only fire on values that are
 * unambiguously our own output.
 */
const REDACTION_SENTINELS = [
  /^\[redacted\]$/,
  // `[\s\S]` rather than `.`: a value whose first four or last two characters
  // include a line terminator still produces the sentinel, and `.` would not
  // match it — leaving the one shape the guard exists for undetected.
  /^[\s\S]{4}\.\.\.\[redacted\]\.\.\.[\s\S]{2}$/,
];

/** Strip query and fragment: the target is for diagnosis, not for echoing
 * request parameters (which can themselves carry credentials) into an error. */
function describeRequestTarget(request: Pick<OAuthHttpRequest, "url">): string {
  try {
    const url = new URL(request.url);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "the authorization server";
  }
}

/**
 * Throw if an executor result carries a redaction sentinel where the flow
 * expects a credential; otherwise return the result unchanged (by identity).
 *
 * Inspects `result.body`, which is where the real executor puts response
 * fields — a check against `result.access_token` would look reasonable and
 * never fire.
 */
export function assertOAuthResultCredentialsUnredacted(
  result: OAuthRequestResult,
  request: Pick<OAuthHttpRequest, "url">,
): OAuthRequestResult {
  const body: unknown = result?.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return result;
  }

  const record = body as Record<string, unknown>;
  for (const field of CONSUMED_CREDENTIAL_FIELDS) {
    const value = record[field];
    if (
      typeof value === "string" &&
      REDACTION_SENTINELS.some((pattern) => pattern.test(value))
    ) {
      throw new OAuthRedactedCredentialError(field, describeRequestTarget(request));
    }
  }

  return result;
}

/**
 * Configuration for creating an OAuth state machine with protocol version selection
 */
export interface OAuthStateMachineFactoryConfig extends BaseOAuthStateMachineConfig {
  protocolVersion: OAuthProtocolVersion;
  registrationStrategy:
    | RegistrationStrategy2025_03_26
    | RegistrationStrategy2025_06_18
    | RegistrationStrategy2025_11_25
    | RegistrationStrategy2026_07_28;
  /**
   * Permit outbound OAuth metadata fetches to loopback hosts (local-dev
   * reflectors). Defaults to `false` (secure): a hostile server must not be
   * able to steer metadata fetches at the user's own `127.0.0.1`/`localhost`.
   * Only an explicit local-dev surface should opt in. The guard blocks
   * LAN/link-local/reserved destinations regardless of this flag.
   */
  allowLoopbackMetadataFetch?: boolean;
  /**
   * Permit outbound OAuth metadata fetches to any private destination —
   * loopback, RFC 1918, CGNAT, unique-local. This is the LOCAL inspector's
   * default: on a developer's own machine, reaching their own network is the
   * product, and the browser could not be steered anywhere the developer's
   * shell cannot already reach. Hosted surfaces must never set it.
   *
   * Supersedes {@link allowLoopbackMetadataFetch}. Link-local and
   * cloud-metadata destinations stay refused either way.
   */
  allowPrivateMetadataFetch?: boolean;
}

/**
 * Creates an OAuth state machine based on the specified protocol version
 *
 * @param config - Configuration including protocol version and registration strategy
 * @returns An OAuth state machine implementation for the specified protocol version
 *
 * @example
 * ```typescript
 * // Create a 2025-11-25 state machine with CIMD
 * const machine = createOAuthStateMachine({
 *   protocolVersion: "2025-11-25",
 *   registrationStrategy: "cimd",
 *   serverUrl: "https://mcp.example.com",
 *   serverName: "Example MCP Server",
 *   state: EMPTY_OAUTH_FLOW_STATE,
 *   updateState: (updates) => setState(updates),
 * });
 *
 * // Create a 2025-06-18 state machine with DCR
 * const legacyMachine = createOAuthStateMachine({
 *   protocolVersion: "2025-06-18",
 *   registrationStrategy: "dcr",
 *   serverUrl: "https://mcp.example.com",
 *   serverName: "Legacy MCP Server",
 *   state: EMPTY_OAUTH_FLOW_STATE,
 *   updateState: (updates) => setState(updates),
 * });
 * ```
 */
export function createOAuthStateMachine(
  config: OAuthStateMachineFactoryConfig,
): OAuthStateMachine {
  const {
    protocolVersion,
    allowLoopbackMetadataFetch,
    allowPrivateMetadataFetch,
    ...rest
  } = config;

  // SSRF guard (shared hardening, all machines at once): every machine hands
  // untrusted metadata URLs (PRM pointer, AS metadata, CIMD) to this executor.
  // Validate the destination before the fetch runs — blocking private/reserved
  // hosts — with an explicit loopback opt-in for local dev.
  const allowLoopback = allowLoopbackMetadataFetch ?? false;
  const allowPrivateNetwork = allowPrivateMetadataFetch ?? false;
  const guardedExecutor: OAuthRequestExecutor = async (request) => {
    // Validate the request URL (initial hop) for every machine request. The
    // executor is responsible for re-validating the FINAL URL after any
    // redirects (see the client executor / DNS-pinning proxy) — a URL-string
    // check here cannot catch a 3xx or DNS-rebind to a private host.
    assertOutboundOAuthUrlAllowed(request.url, {
      allowLoopback,
      allowPrivateNetwork,
    });
    const result = await rest.requestExecutor(request);
    // Second cross-cutting guard at the same seam: catch a trace redactor that
    // was applied to live data before the sentinel is spent as a credential.
    return assertOAuthResultCredentialsUnredacted(result, request);
  };
  const baseConfig = {
    ...rest,
    requestExecutor: guardedExecutor,
    // One merge here reaches every request of every machine — an emulated
    // User-Agent rides the customHeaders channel (the debug proxy and Node
    // fetch both honor a caller-supplied UA).
    customHeaders: applyEmulationUserAgent(rest.customHeaders, rest.emulation),
  };

  switch (protocolVersion) {
    case "2025-03-26":
      // Validate registration strategy for 2025-03-26
      if (config.registrationStrategy === "cimd") {
        throw new Error(
          "CIMD registration is not supported in 2025-03-26 protocol. " +
            "Use 'dcr' or 'preregistered' instead.",
        );
      }
      return create2025_03_26(baseConfig as Config2025_03_26);

    case "2025-06-18":
      // Validate registration strategy for 2025-06-18
      if (config.registrationStrategy === "cimd") {
        throw new Error(
          "CIMD registration is not supported in 2025-06-18 protocol. " +
            "Use 'dcr' or 'preregistered' instead.",
        );
      }
      return create2025_06_18(baseConfig as Config2025_06_18);

    case "2025-11-25":
      // All registration strategies are valid for 2025-11-25
      return create2025_11_25(baseConfig as Config2025_11_25);

    case "2026-07-28":
      // All registration strategies are valid for 2026-07-28
      return create2026_07_28(baseConfig as Config2026_07_28);

    default:
      // TypeScript exhaustiveness check
      const _exhaustive: never = protocolVersion;
      throw new Error(`Unknown protocol version: ${_exhaustive}`);
  }
}

/**
 * Gets the default registration strategy for a given protocol version
 */
export function getDefaultRegistrationStrategy(
  protocolVersion: OAuthProtocolVersion,
): string {
  switch (protocolVersion) {
    case "2025-03-26":
      return "dcr";
    case "2025-06-18":
      return "dcr";
    case "2025-11-25":
      return "cimd";
    case "2026-07-28":
      return "cimd";
    default:
      return "dcr";
  }
}

/**
 * Gets the supported registration strategies for a given protocol version
 */
export function getSupportedRegistrationStrategies(
  protocolVersion: OAuthProtocolVersion,
): ReadonlyArray<string> {
  switch (protocolVersion) {
    case "2025-03-26":
      return ["dcr", "preregistered"] as const;
    case "2025-06-18":
      return ["dcr", "preregistered"] as const;
    case "2025-11-25":
      return ["cimd", "dcr", "preregistered"] as const;
    case "2026-07-28":
      return ["cimd", "dcr", "preregistered"] as const;
    default:
      return ["dcr", "preregistered"] as const;
  }
}

/**
 * Protocol version metadata for UI display. Labels come from
 * `protocolVersionLabel` so a consumer rendering this record cannot disagree
 * with the inspector's dropdowns about which revision is Latest.
 */
export const PROTOCOL_VERSION_INFO = {
  "2025-03-26": {
    label: protocolVersionLabel("2025-03-26"),
    description: "Original MCP OAuth specification with direct discovery",
    features: [
      "Dynamic Client Registration (DCR) SHOULD be supported",
      "Direct RFC8414 discovery from MCP server base URL",
      "Fallback to default endpoints (/authorize, /token, /register)",
      "PKCE is REQUIRED for all clients",
      "No Protected Resource Metadata (RFC9728)",
    ],
  },
  "2025-06-18": {
    label: protocolVersionLabel("2025-06-18"),
    description: "MCP OAuth specification with resource metadata",
    features: [
      "Dynamic Client Registration (DCR) SHOULD be supported",
      "Protected Resource Metadata (RFC9728) required",
      "RFC8414 discovery ONLY (no OIDC) with root fallback",
      "PKCE recommended but not strictly enforced",
    ],
  },
  "2025-11-25": {
    label: protocolVersionLabel("2025-11-25"),
    description: "MCP OAuth specification with CIMD support",
    features: [
      "Client ID Metadata Documents (CIMD) SHOULD be supported",
      "Protected Resource Metadata (RFC9728) required",
      "RFC8414 OR OIDC discovery without root fallback",
      "PKCE strictly required and enforced",
      "Enhanced security with URL-based client IDs",
    ],
  },
  "2026-07-28": {
    label: protocolVersionLabel("2026-07-28"),
    description:
      "Newest MCP OAuth specification: 2025-11-25 discovery plus OIDC application_type",
    features: [
      "Client ID Metadata Documents (CIMD) SHOULD be supported",
      "Protected Resource Metadata (RFC9728) required",
      "RFC8414 OR OIDC discovery without root fallback",
      "PKCE strictly required and enforced",
      "SEP-837: OIDC application_type sent on Dynamic Client Registration",
    ],
  },
} as const;
