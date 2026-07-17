import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHALLENGE_SCOPES,
  SUPPORTED_SCOPES,
  type ReferenceServerConfig,
} from "./config.js";

/** One observed interaction with the reference server. Bodies/params are
 * pre-redacted by the caller — never store secrets, codes, or tokens. */
export interface CaptureEvent {
  ts: string;
  kind:
    | "prm_discovery"
    | "as_metadata_discovery"
    | "dcr_registration"
    | "cimd_fetch"
    | "authorize"
    | "consent"
    | "token_authorization_code"
    | "token_refresh"
    | "token_jwt_bearer"
    | "token_error"
    | "mcp_unauthenticated"
    | "mcp_invalid_token"
    | "mcp_request"
    | "other";
  method: string;
  path: string;
  status: number;
  userAgent?: string;
  detail?: Record<string, unknown>;
}

/** Derived per-client OAuth behavior — the data HP-10 exists to produce.
 * Field vocabulary intentionally mirrors HostConfigOAuthProfileV1 (HP-1). */
export interface DerivedTraits {
  completedFlow: boolean;
  discovery: {
    fetchedProtectedResourceMetadata: boolean;
    prmPathVariant: "path-suffixed" | "root" | "both" | "none";
    asMetadataFormat: "oauth-authorization-server" | "openid-configuration" | "both" | "none";
    asMetadataPathVariant: "path-suffixed" | "root" | "both" | "none";
    triedUnauthenticatedFirst: boolean;
  };
  registration: {
    strategy: "dcr" | "cimd" | "preregistered" | "none";
    dcrIdentity?: {
      clientName?: string;
      clientUri?: string;
      logoUri?: string;
      redirectUris?: string[];
      grantTypes?: string[];
      tokenEndpointAuthMethod?: string;
    };
    cimdClientId?: string;
  };
  authorization: {
    usedPkce: boolean;
    pkceMethod?: string;
    sentState: boolean;
    sendsResourceParamAuthorize: boolean;
    requestedScopes: string[];
    scopeRequestPolicy: "all-advertised" | "challenge-derived" | "subset" | "none-requested" | "other";
    redirectUriKind: "loopback" | "localhost" | "https" | "custom-scheme" | "other" | "none";
    redirectUris: string[];
  };
  token: {
    sendsResourceParamToken: boolean;
    tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic" | "other" | "n/a";
    refreshAttempted: boolean;
    refreshSucceeded: boolean;
    sendsResourceParamRefresh: boolean | null;
    reusedRotatedRefreshToken: boolean;
    usedJwtBearerIdJag: boolean;
  };
  capabilityExercise: {
    mcpMethodsCalled: string[];
    calledTools: boolean;
    calledResources: boolean;
    calledPrompts: boolean;
    respondedToElicitation: boolean;
  };
  failures: string[];
}

/** HP-1 HostConfigOAuthProfileV1-shaped encoding of the derived traits,
 * ready to paste into the host catalog seed / backend oauthProfile once
 * HP-1's PRs land. */
export interface OAuthProfileV1 {
  profileVersion: 1;
  authClass: "oauth" | "header-api-key" | "none";
  sendsResourceParam?: boolean;
  asEndpointDiscovery?: "prm" | "same-origin";
  scopeRequestPolicy?: "all-advertised" | "challenge-derived";
  registrationStrategy?: "cimd" | "dcr" | "preregistered";
  dcrIdentity?: { clientName: string; clientUri?: string; logoUri?: string };
  extensions?: Record<string, unknown>;
}

export interface CaptureReport {
  label: string;
  startedAt: string;
  finishedAt: string;
  serverConfig: {
    publicUrl: string;
    dcr: boolean;
    refreshTokens: boolean;
    requireResource: boolean;
    requirePkce: boolean;
    accessTokenTtl: number;
    xaaEnabled: boolean;
  };
  traits: DerivedTraits;
  oauthProfile: OAuthProfileV1;
  events: CaptureEvent[];
}

const ADVERTISED = new Set<string>(SUPPORTED_SCOPES);
const CHALLENGE = new Set<string>(CHALLENGE_SCOPES);

function classifyScopes(requested: string[]): DerivedTraits["authorization"]["scopeRequestPolicy"] {
  if (requested.length === 0) return "none-requested";
  const set = new Set(requested);
  if (set.size === ADVERTISED.size && [...set].every((s) => ADVERTISED.has(s))) {
    return "all-advertised";
  }
  if (set.size === CHALLENGE.size && [...set].every((s) => CHALLENGE.has(s))) {
    return "challenge-derived";
  }
  if ([...set].every((s) => ADVERTISED.has(s))) return "subset";
  return "other";
}

function classifyRedirectUri(uri: string | undefined): DerivedTraits["authorization"]["redirectUriKind"] {
  if (!uri) return "none";
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return "https";
    if (url.protocol === "http:") {
      if (url.hostname === "127.0.0.1" || url.hostname === "[::1]") return "loopback";
      if (url.hostname === "localhost") return "localhost";
      return "other";
    }
    return "custom-scheme";
  } catch {
    return "other";
  }
}

export class CaptureSession {
  private events: CaptureEvent[] = [];
  private startedAt = new Date().toISOString();
  label: string;

  constructor(
    label: string,
    private readonly config: ReferenceServerConfig,
  ) {
    this.label = label;
  }

  record(event: Omit<CaptureEvent, "ts">): void {
    this.events.push({ ts: new Date().toISOString(), ...event });
  }

  eventCount(): number {
    return this.events.length;
  }

  deriveTraits(): DerivedTraits {
    const events = this.events;
    const byKind = (kind: CaptureEvent["kind"]) => events.filter((e) => e.kind === kind);

    const prm = byKind("prm_discovery");
    const asMeta = byKind("as_metadata_discovery");
    const dcr = byKind("dcr_registration").filter((e) => e.status < 400);
    const cimd = byKind("cimd_fetch").filter((e) => e.status < 400);
    const authorizes = byKind("authorize");
    const codeGrants = byKind("token_authorization_code");
    const okCodeGrants = codeGrants.filter((e) => e.status < 400);
    const refreshes = byKind("token_refresh");
    const jwtBearer = byKind("token_jwt_bearer").filter((e) => e.status < 400);
    const mcpAuthed = byKind("mcp_request");

    const pathVariant = (hits: CaptureEvent[]): "path-suffixed" | "root" | "both" | "none" => {
      const suffixed = hits.some((e) => /\/mcp$/.test(e.path));
      const root = hits.some((e) => !/\/mcp$/.test(e.path));
      if (suffixed && root) return "both";
      if (suffixed) return "path-suffixed";
      if (root) return "root";
      return "none";
    };

    const asFormat = ((): DerivedTraits["discovery"]["asMetadataFormat"] => {
      const oauth = asMeta.some((e) => e.path.includes("oauth-authorization-server"));
      const oidc = asMeta.some((e) => e.path.includes("openid-configuration"));
      if (oauth && oidc) return "both";
      if (oauth) return "oauth-authorization-server";
      if (oidc) return "openid-configuration";
      return "none";
    })();

    // Prefer the last authorize that actually redirected — clients often make
    // failed attempts first, and the successful one is the representative
    // sample of the client's behavior.
    const lastAuthorize =
      [...authorizes].reverse().find((e) => e.status === 302) ?? authorizes.at(-1);
    const authDetail = (lastAuthorize?.detail ?? {}) as Record<string, unknown>;
    const requestedScopes = (authDetail.scopes as string[]) ?? [];
    const redirectUris = [
      ...new Set(
        authorizes
          .map((e) => (e.detail as Record<string, unknown> | undefined)?.redirectUri)
          .filter((u): u is string => typeof u === "string"),
      ),
    ];

    const lastOkCodeGrant = okCodeGrants.at(-1);
    const tokenDetail = (lastOkCodeGrant?.detail ?? {}) as Record<string, unknown>;

    const registrationStrategy = ((): DerivedTraits["registration"]["strategy"] => {
      if (cimd.length > 0) return "cimd";
      if (dcr.length > 0) return "dcr";
      if (authorizes.length > 0 || okCodeGrants.length > 0) return "preregistered";
      return "none";
    })();

    const lastDcr = dcr.at(-1)?.detail as Record<string, unknown> | undefined;

    const mcpMethods = [
      ...new Set(
        mcpAuthed
          .map((e) => (e.detail as Record<string, unknown> | undefined)?.rpcMethod)
          .filter((m): m is string => typeof m === "string"),
      ),
    ];

    const failures: string[] = [];
    if (authorizes.length === 0 && okCodeGrants.length === 0 && jwtBearer.length === 0) {
      failures.push(
        prm.length + asMeta.length > 0
          ? "discovery-only: fetched metadata but never reached /authorize (possible metadata-handling or redirect gap)"
          : "no-oauth-attempt: client never engaged the authorization server",
      );
    }
    if (authorizes.length > 0 && okCodeGrants.length === 0) {
      failures.push("broken-redirect-or-exchange: authorization started but no successful token exchange");
    }
    if (lastAuthorize && !(authDetail.pkce as boolean)) {
      failures.push("no-pkce: authorization request omitted code_challenge");
    }
    if (prm.length === 0 && (authorizes.length > 0 || asMeta.length > 0)) {
      failures.push("no-prm-discovery: skipped RFC 9728 protected-resource metadata (assumed same-origin AS)");
    }
    const refreshFailed = refreshes.length > 0 && !refreshes.some((e) => e.status < 400);
    if (refreshFailed) {
      failures.push("token-refresh-failed: refresh grant attempted but never succeeded");
    }
    const reusedRotated = refreshes.some(
      (e) => (e.detail as Record<string, unknown> | undefined)?.reusedRotatedToken === true,
    );
    if (reusedRotated) {
      failures.push("refresh-rotation-unsupported: client reused a rotated (invalidated) refresh token");
    }
    if (okCodeGrants.length > 0 && mcpAuthed.length === 0) {
      failures.push("token-unused: obtained an access token but never called the MCP server with it");
    }

    return {
      completedFlow: (okCodeGrants.length > 0 || jwtBearer.length > 0) && mcpAuthed.length > 0,
      discovery: {
        fetchedProtectedResourceMetadata: prm.length > 0,
        prmPathVariant: pathVariant(prm),
        asMetadataFormat: asFormat,
        asMetadataPathVariant: pathVariant(asMeta),
        triedUnauthenticatedFirst: byKind("mcp_unauthenticated").length > 0,
      },
      registration: {
        strategy: registrationStrategy,
        dcrIdentity: lastDcr
          ? {
              clientName: lastDcr.clientName as string | undefined,
              clientUri: lastDcr.clientUri as string | undefined,
              logoUri: lastDcr.logoUri as string | undefined,
              redirectUris: lastDcr.redirectUris as string[] | undefined,
              grantTypes: lastDcr.grantTypes as string[] | undefined,
              tokenEndpointAuthMethod: lastDcr.tokenEndpointAuthMethod as string | undefined,
            }
          : undefined,
        cimdClientId: (cimd.at(-1)?.detail as Record<string, unknown> | undefined)?.clientId as
          | string
          | undefined,
      },
      authorization: {
        usedPkce: Boolean(authDetail.pkce),
        pkceMethod: authDetail.pkceMethod as string | undefined,
        sentState: Boolean(authDetail.state),
        sendsResourceParamAuthorize: Boolean(authDetail.resource),
        requestedScopes,
        scopeRequestPolicy: classifyScopes(requestedScopes),
        redirectUriKind: classifyRedirectUri(authDetail.redirectUri as string | undefined),
        redirectUris,
      },
      token: {
        sendsResourceParamToken: Boolean(tokenDetail.resource),
        tokenEndpointAuthMethod:
          (tokenDetail.authMethod as DerivedTraits["token"]["tokenEndpointAuthMethod"]) ??
          (okCodeGrants.length > 0 ? "other" : "n/a"),
        refreshAttempted: refreshes.length > 0,
        refreshSucceeded: refreshes.some((e) => e.status < 400),
        sendsResourceParamRefresh:
          refreshes.length > 0
            ? refreshes.some((e) => Boolean((e.detail as Record<string, unknown>)?.resource))
            : null,
        reusedRotatedRefreshToken: reusedRotated,
        usedJwtBearerIdJag: jwtBearer.length > 0,
      },
      capabilityExercise: {
        mcpMethodsCalled: mcpMethods,
        calledTools: mcpMethods.some((m) => m.startsWith("tools/")),
        calledResources: mcpMethods.some((m) => m.startsWith("resources/")),
        calledPrompts: mcpMethods.some((m) => m.startsWith("prompts/")),
        respondedToElicitation: mcpAuthed.some(
          (e) => (e.detail as Record<string, unknown> | undefined)?.elicitationResult === "answered",
        ),
      },
      failures,
    };
  }

  deriveOAuthProfile(traits: DerivedTraits): OAuthProfileV1 {
    const engaged =
      traits.completedFlow ||
      traits.registration.strategy !== "none" ||
      traits.authorization.redirectUriKind !== "none";

    const profile: OAuthProfileV1 = {
      profileVersion: 1,
      authClass: engaged ? "oauth" : "none",
    };
    if (!engaged) return profile;

    profile.sendsResourceParam =
      traits.authorization.sendsResourceParamAuthorize || traits.token.sendsResourceParamToken;
    profile.asEndpointDiscovery = traits.discovery.fetchedProtectedResourceMetadata
      ? "prm"
      : "same-origin";
    if (traits.authorization.scopeRequestPolicy === "all-advertised") {
      profile.scopeRequestPolicy = "all-advertised";
    } else if (traits.authorization.scopeRequestPolicy === "challenge-derived") {
      profile.scopeRequestPolicy = "challenge-derived";
    }
    if (traits.registration.strategy !== "none") {
      profile.registrationStrategy = traits.registration.strategy;
    }
    if (traits.registration.dcrIdentity?.clientName) {
      profile.dcrIdentity = {
        clientName: traits.registration.dcrIdentity.clientName,
        clientUri: traits.registration.dcrIdentity.clientUri,
        logoUri: traits.registration.dcrIdentity.logoUri,
      };
    }
    profile.extensions = {
      "mcpjam.dev/hp10": {
        completedFlow: traits.completedFlow,
        usedPkce: traits.authorization.usedPkce,
        redirectUriKind: traits.authorization.redirectUriKind,
        refreshSucceeded: traits.token.refreshSucceeded,
        usedJwtBearerIdJag: traits.token.usedJwtBearerIdJag,
        failures: traits.failures,
      },
    };
    return profile;
  }

  buildReport(): CaptureReport {
    const traits = this.deriveTraits();
    return {
      label: this.label,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      serverConfig: {
        publicUrl: this.config.publicUrl,
        dcr: this.config.dcr,
        refreshTokens: this.config.refreshTokens,
        requireResource: this.config.requireResource,
        requirePkce: this.config.requirePkce,
        accessTokenTtl: this.config.accessTokenTtl,
        xaaEnabled: this.config.xaaIssuer.length > 0,
      },
      traits,
      oauthProfile: this.deriveOAuthProfile(traits),
      events: this.events,
    };
  }

  /** Write the report to <captureDir>/<label>.json. Returns the path. */
  flush(): string {
    mkdirSync(this.config.captureDir, { recursive: true });
    const safeLabel = this.label.replace(/[^a-z0-9_-]/gi, "_");
    const file = join(this.config.captureDir, `${safeLabel}.json`);
    writeFileSync(file, JSON.stringify(this.buildReport(), null, 2));
    return file;
  }
}
