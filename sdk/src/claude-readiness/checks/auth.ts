/**
 * Non-invasive authentication checks.
 *
 * Everything here reasons over metadata the runner already fetched: an
 * unauthenticated probe, a Protected Resource Metadata document, one
 * authorization-server metadata document. Zero side effects — nothing here
 * registers a client, spends a grant, or consumes a rate limit. The probes
 * that do live behind the intrusive opt-in and are not in this module.
 *
 * THE CLASSIFY-DON'T-FAIL RULE. Static-header credentials, authless servers,
 * custom connection flows and preregistered clients are all valid ways to ship
 * a connector, and a wire-only runner frequently cannot tell them apart from
 * each other or from a broken OAuth setup. Failing on that ambiguity would
 * reject working connectors for being unusual. So the auth MODE is reported as
 * a badge, and only the things that are unambiguously broken — an
 * unreachable first authorization server, a challenge that names no metadata —
 * become findings.
 *
 * Pure: takes evidence, returns findings and badges. It dials nothing.
 */

import { parseBearerAuthenticateParameters } from "../../oauth/state-machines/shared/challenges.js";
import { claudePolicySource } from "../manifest.js";
import type {
  ClaudeCapabilityBadge,
  ClaudeReadinessFinding,
} from "../types.js";
import {
  informational,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type ClaudeCheckDefinition,
  type ClaudeCheckStamp,
} from "./helpers.js";

// ── Evidence ────────────────────────────────────────────────────────────

/** The order RFC 9728 discovery is attempted in, and which step answered. */
export type ClaudePrmDiscoveryStep =
  | "www-authenticate"
  | "well-known-path-suffixed"
  | "well-known-root"
  | "not-found";

export interface ClaudeAuthEvidence {
  /** The connector URL exactly as entered — not canonicalized. */
  enteredUrl: string;
  /** An unauthenticated request to the MCP endpoint. */
  unauthenticated?: {
    status: number;
    wwwAuthenticate?: string;
    /**
     * Whether this response was an attempted PROTECTED operation. A
     * `WWW-Authenticate` header on a 200 means nothing on, say, a health
     * endpoint or a discovery response; it is only wrong when the response
     * represents an auth denial that nonetheless succeeded.
     */
    representsProtectedOperation: boolean;
    /** The server served the request without credentials. */
    servedWithoutCredentials: boolean;
  };
  prm?: {
    discoveredVia: ClaudePrmDiscoveryStep;
    url?: string;
    document?: Record<string, unknown>;
    fetchError?: string;
    /**
     * A `resource_metadata` pointer discovery refused to dial — off-origin, or
     * not http(s). Recorded rather than dropped: the server published a
     * pointer no conforming client can follow, and silence would look like the
     * server never published one.
     */
    rejectedPointer?: string;
  };
  /**
   * Metadata for `authorization_servers[0]` ONLY. Claude does not fall back to
   * later entries, so the health of the first one is the whole question and a
   * runner that probed all of them would be grading a different client.
   */
  firstAuthorizationServer?: {
    issuer: string;
    metadataUrl?: string;
    reachable: boolean;
    document?: Record<string, unknown>;
    fetchError?: string;
  };
  /** A `403` step-up challenge, if the run happened to see one. */
  insufficientScopeChallenge?: { header: string };
  /**
   * The RFC 8707 `resource` parameter the CLIENT actually sent, per endpoint.
   * Present only when the run completed an authorization — which is why the
   * check that reads it declares `interactive-oauth` as a prerequisite rather
   * than guessing from the metadata.
   */
  resourceIndicatorsSent?: {
    authorize?: string;
    token?: string;
  };
  /**
   * The `aud` claim of an access token the caller supplied, when it was a JWT.
   * EVIDENCE ONLY — see the check.
   */
  accessTokenAudience?: string[];
  /** What the submitter declared, when a submission profile was supplied. */
  declaredAuthMode?: string;
}

// ── Check definitions ───────────────────────────────────────────────────

/**
 * The input that lets {@link RFC8707_RESOURCE_CANONICAL} run.
 *
 * A completed authorization is not enough on its own: an access token is the
 * OUTPUT of the flow and carries no record of the `resource` parameter that
 * was sent to reach it. The caller that drove `/authorize` and `/token` is the
 * only party that saw those requests, so it has to hand them back.
 */
export const CLAUDE_AUTHORIZATION_REQUESTS_INPUT = "authorizationRequests";

const CHALLENGE_PRESENT: ClaudeCheckDefinition = {
  id: "claude.auth.unauthenticated-challenge",
  title: "An unauthenticated request is answered with a usable 401 challenge",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: claudePolicySource("authentication", "§Discovery → 401 challenge"),
  provenance: "wire",
};

const CHALLENGE_NAMES_METADATA: ClaudeCheckDefinition = {
  id: "claude.auth.challenge-names-resource-metadata",
  title: "The 401 challenge points at the Protected Resource Metadata",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: claudePolicySource("authentication", "§Discovery → resource_metadata"),
  provenance: "wire",
};

const WWW_AUTH_ON_SUCCESS: ClaudeCheckDefinition = {
  id: "claude.auth.no-challenge-on-successful-operation",
  title: "A successful protected operation does not also send a challenge",
  lane: "runtime-compatibility",
  class: "recommended",
  source: claudePolicySource("troubleshooting", "§Auth → Mixed signals"),
  provenance: "wire",
};

const PRM_DISCOVERABLE: ClaudeCheckDefinition = {
  id: "claude.auth.prm-discoverable",
  title: "Protected Resource Metadata is discoverable in the documented order",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: claudePolicySource("authentication", "§Discovery order"),
  provenance: "wire",
};

const PRM_RESOURCE_MATCHES_ENTERED: ClaudeCheckDefinition = {
  id: "claude.auth.prm-resource-matches-entered-url",
  title: "PRM `resource` is exactly the URL the user entered",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: claudePolicySource("authentication", "§Protected Resource Metadata"),
  provenance: "wire",
};

const RFC8707_RESOURCE_CANONICAL: ClaudeCheckDefinition = {
  id: "claude.auth.rfc8707-resource-canonical",
  title: "The RFC 8707 `resource` sent to /authorize and /token is canonical",
  lane: "runtime-compatibility",
  class: "required",
  source: claudePolicySource("authentication", "§Resource indicators"),
  provenance: "wire",
  requiresCapabilities: ["interactive-oauth"],
};

const FIRST_AS_USABLE: ClaudeCheckDefinition = {
  id: "claude.auth.first-authorization-server-usable",
  title: "The first `authorization_servers` entry serves valid metadata",
  lane: "runtime-compatibility",
  // A BLOCKER, not a warning. Claude takes entry zero and never falls back, so
  // a broken first entry is a connector that cannot be used — regardless of how
  // healthy entries one and two are.
  class: "runtime-blocker",
  source: claudePolicySource("authentication", "§Authorization servers"),
  provenance: "wire",
};

const PKCE_S256: ClaudeCheckDefinition = {
  id: "claude.auth.pkce-s256-advertised",
  title: "The authorization server advertises S256 PKCE",
  lane: "runtime-compatibility",
  class: "required",
  source: claudePolicySource("authentication", "§Authorization code flow"),
  provenance: "wire",
};

const CIMD_FLAG_CONSISTENT: ClaudeCheckDefinition = {
  id: "claude.auth.cimd-flag-consistent",
  title: "A CIMD advertisement is consistent with the rest of the metadata",
  lane: "runtime-compatibility",
  class: "required",
  source: claudePolicySource("authentication", "§Client identity"),
  provenance: "wire",
};

const CLIENT_ACQUISITION_PATH: ClaudeCheckDefinition = {
  id: "claude.auth.client-acquisition-path",
  title: "Claude has a way to obtain a client identity",
  lane: "runtime-compatibility",
  class: "required",
  source: claudePolicySource("authentication", "§Client registration"),
  provenance: "wire",
};

const SCOPE_CHALLENGE_SHAPE: ClaudeCheckDefinition = {
  id: "claude.auth.insufficient-scope-challenge-shape",
  title: "An insufficient_scope challenge is well-formed",
  lane: "runtime-compatibility",
  class: "required",
  source: claudePolicySource("authentication", "§Step-up authorization"),
  provenance: "wire",
};

const TOKEN_AUDIENCE: ClaudeCheckDefinition = {
  id: "claude.auth.access-token-audience",
  title: "Access-token audience, recorded",
  lane: "experience-insights",
  // EVIDENCE ONLY, and the class says so. See the check for why an `aud` that
  // does not name the resource proves nothing.
  class: "manual-review",
  source: claudePolicySource("authentication", "§Token audience"),
  provenance: "wire",
};

// ── Helpers ─────────────────────────────────────────────────────────────

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * The canonical form of a resource indicator (RFC 8707 §2): scheme and host
 * lowercased, default port removed, no fragment, and no query. The path is
 * KEPT — an MCP server at `/mcp` is a different resource from the origin.
 *
 * DELIBERATELY NOT `canonicalizeResourceUrl` from `oauth/resource-policy.ts`,
 * and the difference is the point rather than an oversight. That function is
 * the client's own canonicalizer: it keeps the query and keeps a default port,
 * because its job is to build a value MCPJam will send and then match. This one
 * grades what CLAUDE sends, and Claude's documented form drops both. Unifying
 * them would make the check pass values Claude would never produce, so if the
 * two ever need to converge it has to be because the documentation moved —
 * check the manifest revision, not this comment.
 */
export function canonicalResourceIndicator(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  parsed.hash = "";
  parsed.search = "";
  const isDefaultPort =
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80");
  if (isDefaultPort) parsed.port = "";
  // `new URL("https://x.example")` renders a trailing slash that the entered
  // string may not have had; an empty path is the one place the two forms are
  // genuinely the same resource.
  const rendered = parsed.toString();
  return parsed.pathname === "/" && !url.endsWith("/")
    ? rendered.replace(/\/$/, "")
    : rendered;
}

/**
 * Read the RFC 8707 `resource` parameter out of the two requests that carry
 * it, so a caller that drove an authorization can report what it sent.
 *
 * Exists because every surface that completes a flow would otherwise write
 * this parsing itself, and each copy would be a chance to read the wrong
 * parameter and hand the check a value the client never sent — worse than the
 * `not-evaluated` it replaces, because a wrong verdict does not announce
 * itself.
 *
 * Returns `undefined` when neither request carried a `resource`. That is NOT a
 * violation: absence means we still have nothing to grade, and the check must
 * go on saying so rather than reading a missing parameter as a bad one.
 */
export function resourceIndicatorsFrom(requests: {
  /** The full `/authorize` URL, `resource` included, as it was sent. */
  authorizationUrl?: string;
  /** The `/token` request body — form-encoded string, params, or a record. */
  tokenRequestBody?: string | URLSearchParams | Record<string, string>;
}): ClaudeAuthEvidence["resourceIndicatorsSent"] | undefined {
  let authorize: string | undefined;
  if (requests.authorizationUrl) {
    try {
      authorize =
        new URL(requests.authorizationUrl).searchParams.get("resource") ??
        undefined;
    } catch {
      authorize = undefined;
    }
  }

  let token: string | undefined;
  const body = requests.tokenRequestBody;
  if (typeof body === "string") {
    token = new URLSearchParams(body).get("resource") ?? undefined;
  } else if (body instanceof URLSearchParams) {
    token = body.get("resource") ?? undefined;
  } else if (body) {
    token = typeof body.resource === "string" ? body.resource : undefined;
  }

  if (authorize === undefined && token === undefined) return undefined;
  return { authorize, token };
}

// ── The run ─────────────────────────────────────────────────────────────

export interface ClaudeAuthCheckOutput {
  findings: ClaudeReadinessFinding[];
  badges: ClaudeCapabilityBadge[];
}

export function runClaudeAuthChecks(
  evidence: ClaudeAuthEvidence,
  stamp: ClaudeCheckStamp,
): ClaudeAuthCheckOutput {
  const findings: ClaudeReadinessFinding[] = [];
  const badges: ClaudeCapabilityBadge[] = [];

  const probe = evidence.unauthenticated;
  const challengeParams = parseBearerAuthenticateParameters(
    probe?.wwwAuthenticate,
  );
  const requiresAuth = probe?.status === 401;
  const servedWithoutAuth = probe?.servedWithoutCredentials === true;

  // ── Auth mode: a badge, never a verdict ──────────────────────────────
  const mode = classifyAuthMode(evidence, requiresAuth, servedWithoutAuth);
  badges.push({
    id: "claude.auth.mode",
    title: "Authentication mode",
    state: mode.confident ? "supported" : "claimed",
    detail: mode.detail,
    provenance: mode.confident ? "wire" : "declared",
  });

  // ── The 401 contract ─────────────────────────────────────────────────
  if (!probe) {
    const reason = "the run never made an unauthenticated request";
    findings.push(notEvaluated(CHALLENGE_PRESENT, stamp, reason));
    findings.push(notEvaluated(CHALLENGE_NAMES_METADATA, stamp, reason));
    findings.push(notEvaluated(WWW_AUTH_ON_SUCCESS, stamp, reason));
  } else if (servedWithoutAuth) {
    // An authless server is a valid submission mode. Nothing about the 401
    // contract can apply to a server that never issues one.
    const reason =
      "the server served the request without credentials, so it does not use the 401 challenge flow";
    findings.push(notApplicable(CHALLENGE_PRESENT, stamp, reason));
    findings.push(notApplicable(CHALLENGE_NAMES_METADATA, stamp, reason));
    findings.push(
      probe.wwwAuthenticate && probe.representsProtectedOperation
        ? violated(
            WWW_AUTH_ON_SUCCESS,
            stamp,
            "This response both succeeded and carried a `WWW-Authenticate` challenge. Claude reads the challenge and starts an authorization it did not need.",
            { status: probe.status, wwwAuthenticate: probe.wwwAuthenticate },
          )
        : satisfied(WWW_AUTH_ON_SUCCESS, stamp, { status: probe.status }),
    );
  } else {
    findings.push(
      requiresAuth
        ? satisfied(CHALLENGE_PRESENT, stamp, { status: probe.status })
        : violated(
            CHALLENGE_PRESENT,
            stamp,
            `An unauthenticated request answered ${probe.status}. Claude needs a 401 with a \`WWW-Authenticate: Bearer\` challenge to begin authorization.`,
            { status: probe.status },
          ),
    );
    findings.push(
      challengeParams.resource_metadata
        ? satisfied(CHALLENGE_NAMES_METADATA, stamp, {
            resourceMetadata: challengeParams.resource_metadata,
          })
        : violated(
            CHALLENGE_NAMES_METADATA,
            stamp,
            "Add `resource_metadata=\"…\"` to the `WWW-Authenticate` challenge so Claude can find the Protected Resource Metadata without guessing a well-known path.",
            { wwwAuthenticate: probe.wwwAuthenticate },
          ),
    );
    // A challenge on a 401 IS the point; this check is only about a challenge
    // riding on a response that succeeded.
    findings.push(
      notApplicable(
        WWW_AUTH_ON_SUCCESS,
        stamp,
        "the probed response was an auth denial, which is where a challenge belongs",
      ),
    );
  }

  // ── PRM ──────────────────────────────────────────────────────────────
  const prm = evidence.prm;
  if (!prm) {
    const reason = "the run did not attempt Protected Resource Metadata discovery";
    findings.push(notEvaluated(PRM_DISCOVERABLE, stamp, reason));
    findings.push(notEvaluated(PRM_RESOURCE_MATCHES_ENTERED, stamp, reason));
  } else if (servedWithoutAuth && prm.discoveredVia === "not-found") {
    const reason =
      "the server is authless, so it publishes no Protected Resource Metadata";
    findings.push(notApplicable(PRM_DISCOVERABLE, stamp, reason));
    findings.push(notApplicable(PRM_RESOURCE_MATCHES_ENTERED, stamp, reason));
  } else {
    findings.push(
      prm.discoveredVia === "not-found"
        ? violated(
            PRM_DISCOVERABLE,
            stamp,
            "Publish Protected Resource Metadata — via the challenge's `resource_metadata` pointer, or at `/.well-known/oauth-protected-resource` with the resource path appended.",
            { fetchError: prm.fetchError },
          )
        : prm.rejectedPointer
          ? // Discovery SUCCEEDED, via a fallback — and the server still
            // published a pointer no conforming client can follow. Reporting
            // only the success would hide a defect that breaks any client
            // which trusts the challenge, which is most of them.
            violated(
              PRM_DISCOVERABLE,
              stamp,
              "The 401 challenge points at a Protected Resource Metadata URL on another origin (or a non-http scheme). Point it at this connector's own origin — a conforming client refuses to follow it, and only found your metadata by falling back to the well-known path.",
              {
                discoveredVia: prm.discoveredVia,
                url: prm.url,
                rejectedPointer: prm.rejectedPointer,
              },
            )
          : satisfied(PRM_DISCOVERABLE, stamp, {
              discoveredVia: prm.discoveredVia,
              url: prm.url,
            }),
    );

    // TWO DIFFERENT REQUIREMENTS, deliberately not one check. This one is
    // about the document: PRM `resource` must equal the URL the user typed,
    // because that is the string Claude matched the connector on. The
    // canonical-form requirement below is about what the CLIENT sends, and a
    // server can satisfy either one while failing the other.
    const declared = prm.document?.resource;
    findings.push(
      typeof declared !== "string"
        ? prm.discoveredVia === "not-found"
          ? notEvaluated(
              PRM_RESOURCE_MATCHES_ENTERED,
              stamp,
              "no Protected Resource Metadata document was retrieved",
            )
          : violated(
              PRM_RESOURCE_MATCHES_ENTERED,
              stamp,
              "The Protected Resource Metadata document has no `resource` field.",
              { document: prm.document },
            )
        : declared === evidence.enteredUrl
          ? satisfied(PRM_RESOURCE_MATCHES_ENTERED, stamp, { resource: declared })
          : violated(
              PRM_RESOURCE_MATCHES_ENTERED,
              stamp,
              `PRM declares \`resource: "${declared}"\` but the connector URL is "${evidence.enteredUrl}". Claude compares these exactly — a trailing slash or a different host is a mismatch.`,
              { declared, entered: evidence.enteredUrl },
            ),
    );
  }

  // THE SECOND HALF OF THE RESOURCE STORY. The PRM check above is about the
  // document; this one is about what the CLIENT sends, and a server can
  // satisfy either while failing the other. It needs an authorization to have
  // happened, so a headless run reports it unevaluated rather than inferring
  // it from metadata that says nothing about the parameter.
  const canonical = canonicalResourceIndicator(evidence.enteredUrl);
  const sent = evidence.resourceIndicatorsSent;
  if (!sent || (sent.authorize === undefined && sent.token === undefined)) {
    findings.push(
      notEvaluated(
        RFC8707_RESOURCE_CANONICAL,
        stamp,
        "checking the `resource` parameter on /authorize and /token requires completing an authorization, which this run did not do",
        {
          expectedCanonicalForm: canonical,
          missingInput: CLAUDE_AUTHORIZATION_REQUESTS_INPUT,
        },
      ),
    );
  } else {
    const wrong = (["authorize", "token"] as const).filter(
      (endpoint) =>
        sent[endpoint] !== undefined && sent[endpoint] !== canonical,
    );
    findings.push(
      wrong.length === 0
        ? satisfied(RFC8707_RESOURCE_CANONICAL, stamp, {
            canonical,
            sent,
          })
        : violated(
            RFC8707_RESOURCE_CANONICAL,
            stamp,
            `The \`resource\` parameter must be the canonical form \`${canonical}\` — lowercased scheme and host, no default port, no query, no fragment — on every endpoint that carries it.`,
            {
              canonical,
              sent,
              endpoints: wrong,
            },
          ),
    );
  }

  // ── Authorization server ─────────────────────────────────────────────
  const authServers = stringArray(prm?.document?.authorization_servers);
  const first = evidence.firstAuthorizationServer;
  if (!prm || prm.discoveredVia === "not-found") {
    const reason = "no Protected Resource Metadata document named an authorization server";
    for (const definition of [
      FIRST_AS_USABLE,
      PKCE_S256,
      CIMD_FLAG_CONSISTENT,
      CLIENT_ACQUISITION_PATH,
    ]) {
      findings.push(
        servedWithoutAuth
          ? notApplicable(definition, stamp, "the server is authless")
          : notEvaluated(definition, stamp, reason),
      );
    }
  } else if (authServers.length === 0) {
    findings.push(
      violated(
        FIRST_AS_USABLE,
        stamp,
        "Protected Resource Metadata lists no `authorization_servers`, so Claude has nowhere to send the user.",
        { document: prm.document },
      ),
    );
    for (const definition of [PKCE_S256, CIMD_FLAG_CONSISTENT, CLIENT_ACQUISITION_PATH]) {
      findings.push(
        notEvaluated(
          definition,
          stamp,
          "no authorization server was named, so its metadata could not be read",
        ),
      );
    }
  } else if (!first || !first.reachable || !first.document) {
    findings.push(
      violated(
        FIRST_AS_USABLE,
        stamp,
        `Claude uses \`authorization_servers[0]\` and does not fall back to later entries. Fix "${authServers[0]}" or list a working server first.`,
        {
          issuer: authServers[0],
          metadataUrl: first?.metadataUrl,
          fetchError: first?.fetchError,
          // Naming the alternatives makes the "no fallback" rule concrete for
          // a submitter whose second entry is perfectly healthy.
          otherEntries: authServers.slice(1),
        },
      ),
    );
    for (const definition of [PKCE_S256, CIMD_FLAG_CONSISTENT, CLIENT_ACQUISITION_PATH]) {
      findings.push(
        notEvaluated(
          definition,
          stamp,
          "the first authorization server's metadata could not be read",
        ),
      );
    }
  } else {
    const document = first.document;
    findings.push(
      satisfied(FIRST_AS_USABLE, stamp, {
        issuer: first.issuer,
        metadataUrl: first.metadataUrl,
      }),
    );

    const pkceMethods = stringArray(document.code_challenge_methods_supported);
    findings.push(
      pkceMethods.includes("S256")
        ? satisfied(PKCE_S256, stamp, { methods: pkceMethods })
        : violated(
            PKCE_S256,
            stamp,
            "Advertise `S256` in `code_challenge_methods_supported`. Claude always sends a PKCE challenge, and a server that does not advertise S256 support cannot be assumed to verify it.",
            { methods: pkceMethods },
          ),
    );

    // THE CIMD READING, stated so a reviewer can correct it: an advertisement
    // is two claims, not one — that the server accepts a URL client_id, AND
    // that it runs the code flow such a client would use. A `true` flag on a
    // server advertising no `code` response type is an advertisement for a
    // flow that cannot happen, and Claude would select it and then fail.
    const cimdFlag = document.client_id_metadata_document_supported;
    const responseTypes = stringArray(document.response_types_supported);
    const registrationEndpoint =
      typeof document.registration_endpoint === "string"
        ? document.registration_endpoint
        : undefined;
    if (cimdFlag === undefined) {
      findings.push(
        notApplicable(
          CIMD_FLAG_CONSISTENT,
          stamp,
          "the authorization server does not advertise client-ID-metadata-document support",
        ),
      );
    } else if (typeof cimdFlag !== "boolean") {
      findings.push(
        violated(
          CIMD_FLAG_CONSISTENT,
          stamp,
          "`client_id_metadata_document_supported` must be a JSON boolean; a string is not read as a claim of support.",
          { value: cimdFlag },
        ),
      );
    } else if (cimdFlag && !responseTypes.includes("code")) {
      findings.push(
        violated(
          CIMD_FLAG_CONSISTENT,
          stamp,
          "The server advertises client-ID-metadata-document support but no `code` response type, so the flow a CIMD client would run is not offered.",
          { responseTypes },
        ),
      );
    } else {
      findings.push(
        satisfied(CIMD_FLAG_CONSISTENT, stamp, {
          clientIdMetadataDocumentSupported: cimdFlag,
          responseTypes,
        }),
      );
    }

    const hasDcr = registrationEndpoint !== undefined;
    const hasCimd = cimdFlag === true;
    if (hasDcr || hasCimd) {
      findings.push(
        satisfied(CLIENT_ACQUISITION_PATH, stamp, {
          dynamicClientRegistration: hasDcr,
          clientIdMetadataDocument: hasCimd,
        }),
      );
      badges.push({
        id: "claude.auth.client-acquisition",
        title: "Client acquisition",
        state: "supported",
        detail: [hasDcr && "dynamic registration", hasCimd && "client ID metadata document"]
          .filter(Boolean)
          .join(" + "),
        provenance: "wire",
      });
    } else {
      // A preregistered client is a legitimate submission mode; Anthropic
      // issues the credentials out of band. So this is only a failure when
      // nothing was declared — otherwise it is a classification.
      const preregistered = evidence.declaredAuthMode === "oauth-preregistered";
      findings.push(
        preregistered
          ? satisfied(CLIENT_ACQUISITION_PATH, stamp, {
              mode: "preregistered",
              declared: evidence.declaredAuthMode,
            })
          : violated(
              CLIENT_ACQUISITION_PATH,
              stamp,
              "The authorization server offers neither dynamic registration nor client-ID-metadata-document support. If clients are preregistered out of band, declare `oauth-preregistered` in the submission profile so this is classified rather than flagged.",
              { registrationEndpoint, clientIdMetadataDocumentSupported: cimdFlag },
            ),
      );
      badges.push({
        id: "claude.auth.client-acquisition",
        title: "Client acquisition",
        state: preregistered ? "claimed" : "unsupported",
        detail: preregistered
          ? "preregistered client, declared by the submitter"
          : "no dynamic registration and no client ID metadata document",
        provenance: preregistered ? "declared" : "wire",
      });
    }
  }

  // ── Step-up challenge shape ──────────────────────────────────────────
  const stepUp = evidence.insufficientScopeChallenge;
  if (!stepUp) {
    findings.push(
      notApplicable(
        SCOPE_CHALLENGE_SHAPE,
        stamp,
        "this run observed no insufficient_scope challenge",
      ),
    );
  } else {
    const params = parseBearerAuthenticateParameters(stepUp.header);
    // `scope` IS OPTIONAL. Claude performs scope selection when it is omitted,
    // so requiring it would fail a conforming server for not sending something
    // the client does not need.
    findings.push(
      params.error === "insufficient_scope"
        ? satisfied(SCOPE_CHALLENGE_SHAPE, stamp, {
            scope: params.scope,
            scopeOmitted: params.scope === undefined,
          })
        : violated(
            SCOPE_CHALLENGE_SHAPE,
            stamp,
            'A step-up challenge must carry `error="insufficient_scope"` so Claude re-authorizes instead of treating it as a permanent denial.',
            { header: stepUp.header, error: params.error },
          ),
    );
  }

  // ── Token audience: evidence, not a verdict ──────────────────────────
  findings.push(
    evidence.accessTokenAudience === undefined
      ? notApplicable(
          TOKEN_AUDIENCE,
          stamp,
          "no JWT access token was available to inspect",
        )
      : informational(
          TOKEN_AUDIENCE,
          stamp,
          {
            audience: evidence.accessTokenAudience,
            resource: evidence.enteredUrl,
          },
          // An `aud` that does not name the resource does NOT prove a
          // mismatch: the server may bind the audience by an equivalent
          // identifier, and an opaque token has no `aud` to read at all. This
          // is recorded so a reviewer can weigh it, never graded.
          "An audience that does not name the connector URL is not by itself a defect — audience binding can be equivalent rather than literal, and opaque tokens carry no `aud` at all.",
        ),
  );

  return { findings, badges };
}

/**
 * What kind of authentication this connector uses.
 *
 * `confident` is false whenever the observation is consistent with more than
 * one legitimate mode — which is most of the time from outside. The badge
 * carries the uncertainty rather than resolving it, because resolving it is
 * how a static-header connector gets reported as broken OAuth.
 */
function classifyAuthMode(
  evidence: ClaudeAuthEvidence,
  requiresAuth: boolean,
  servedWithoutAuth: boolean,
): { detail: string; confident: boolean } {
  const document = evidence.firstAuthorizationServer?.document;
  if (document?.registration_endpoint) {
    return { detail: "OAuth with dynamic client registration", confident: true };
  }
  if (document?.client_id_metadata_document_supported === true) {
    return { detail: "OAuth with a client ID metadata document", confident: true };
  }
  if (requiresAuth && evidence.prm?.discoveredVia !== "not-found") {
    return {
      detail: "OAuth with a preregistered client",
      // Indistinguishable from an AS whose metadata we failed to read fully.
      confident: false,
    };
  }
  if (servedWithoutAuth) {
    return {
      detail: evidence.declaredAuthMode
        ? `served without credentials; submitter declares ${evidence.declaredAuthMode}`
        : "served without credentials — authless, or credentials carried in a static header",
      // A static-header connector looks exactly like an authless one here.
      confident: false,
    };
  }
  return {
    detail: evidence.declaredAuthMode
      ? `not determined from the wire; submitter declares ${evidence.declaredAuthMode}`
      : "not determined from the wire",
    confident: false,
  };
}
