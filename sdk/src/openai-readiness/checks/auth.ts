/**
 * Authorization checks.
 *
 * WHAT IS DERIVED AND WHAT IS OBSERVED. The oauth-conformance suite already
 * grades the parts of this that are PROTOCOL: that a 401 carries a
 * `WWW-Authenticate` challenge, that PRM's `resource` echoes the request URL,
 * that the authorization server advertises PKCE `S256`. Those findings are
 * marked `derivedFrom` and cite the suite check they rest on rather than being
 * re-observed here, because a second implementation of the same rule is a
 * second opinion about the same server, and the first question anyone asks
 * about a disagreement is which one to believe.
 *
 * WHAT IS GENUINELY OPENAI'S, and therefore observed here:
 *
 *   - MULTIPLE authorization issuers. Anthropic's client uses
 *     `authorization_servers[0]` and nothing else, so Claude's runner stops
 *     there on purpose. ChatGPT documents support for more than one, which
 *     makes "every advertised issuer resolves" a real requirement rather than
 *     a courtesy — and makes a runner that checked only the first report a
 *     multi-issuer server as healthy on the strength of an entry the host may
 *     never pick.
 *   - RFC 9207 `iss`. Without it a client with several issuers cannot tell
 *     which one answered, which is exactly the case multi-issuer support
 *     creates.
 *   - `_meta["mcp/www_authenticate"]`, the runtime challenge carried in a
 *     JSON-RPC error rather than an HTTP header.
 *   - Client ID Metadata Documents as an alternative to registration.
 *   - Service-account and workspace-domain flows, which the docs state are not
 *     supported for a public submission.
 *
 * Pure data. No transport.
 */

import { openaiPolicySource } from "../manifest.js";
import {
  OPENAI_READINESS_INPUTS,
  type OpenAIReadinessFinding,
} from "../types.js";
import type { OpenAIAuthEvidence } from "../discovery.js";
import {
  derivedFrom,
  informational,
  missingInput,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type OpenAICheckDefinition,
  type OpenAICheckStamp,
} from "./helpers.js";

const CHALLENGE_PRESENT: OpenAICheckDefinition = {
  id: "openai.auth.challenge",
  title:
    "An unauthenticated call answers 401 with a WWW-Authenticate challenge",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: openaiPolicySource("build/auth", "§Authorization flow"),
  provenance: "wire",
};

const PRM_DISCOVERABLE: OpenAICheckDefinition = {
  id: "openai.auth.prm-discoverable",
  title: "Protected Resource Metadata is discoverable",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: openaiPolicySource("build/auth", "§Protected resource metadata"),
  provenance: "wire",
};

const PRM_POINTER_USABLE: OpenAICheckDefinition = {
  id: "openai.auth.prm-pointer",
  title: "The challenge's resource_metadata pointer is one a client can follow",
  lane: "runtime-compatibility",
  class: "required",
  source: openaiPolicySource("build/auth", "§Protected resource metadata"),
  provenance: "wire",
};

const ALL_ISSUERS_RESOLVE: OpenAICheckDefinition = {
  id: "openai.auth.issuers-resolve",
  title: "Every advertised authorization server publishes usable metadata",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: openaiPolicySource("build/auth", "§Authorization servers"),
  provenance: "wire",
};

const PKCE_S256: OpenAICheckDefinition = {
  id: "openai.auth.pkce-s256",
  title: "Every authorization server supports PKCE with S256",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: openaiPolicySource("build/auth", "§Authorization flow"),
  provenance: "wire",
};

const ISSUER_PARAMETER: OpenAICheckDefinition = {
  id: "openai.auth.rfc9207-iss",
  title: "Authorization responses identify the issuer (RFC 9207)",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("build/auth", "§Authorization servers"),
  provenance: "wire",
};

const CLIENT_ACQUISITION: OpenAICheckDefinition = {
  id: "openai.auth.client-acquisition",
  title: "A client can obtain credentials without a manual step",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: openaiPolicySource("build/auth", "§Client registration"),
  provenance: "wire",
};

const RUNTIME_CHALLENGE: OpenAICheckDefinition = {
  id: "openai.auth.runtime-challenge",
  title: "A mid-session authorization error carries mcp/www_authenticate",
  lane: "directory-policy",
  class: "recommended",
  source: openaiPolicySource("build/auth", "§Runtime authorization"),
  provenance: "wire",
};

const UNSUPPORTED_FLOWS: OpenAICheckDefinition = {
  id: "openai.auth.unsupported-flows",
  title: "The server does not require a flow public submissions cannot use",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("build/auth", "§Unsupported flows"),
  provenance: "wire",
};

const ALL: OpenAICheckDefinition[] = [
  CHALLENGE_PRESENT,
  PRM_DISCOVERABLE,
  PRM_POINTER_USABLE,
  ALL_ISSUERS_RESOLVE,
  PKCE_S256,
  ISSUER_PARAMETER,
  CLIENT_ACQUISITION,
  RUNTIME_CHALLENGE,
  UNSUPPORTED_FLOWS,
];

/** Grant types a public submission cannot rely on, per the auth guide. */
const UNSUPPORTED_GRANT_TYPES = [
  "client_credentials",
  "urn:ietf:params:oauth:grant-type:jwt-bearer",
  "password",
];

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function runOpenAIAuthChecks(
  evidence: OpenAIAuthEvidence | undefined,
  stamp: OpenAICheckStamp,
): OpenAIReadinessFinding[] {
  if (!evidence) {
    return ALL.map((definition) =>
      notEvaluated(
        definition,
        stamp,
        "this run was given no endpoint to authenticate against",
        missingInput(OPENAI_READINESS_INPUTS.serverUrl),
      ),
    );
  }

  const findings: OpenAIReadinessFinding[] = [];
  const unauth = evidence.unauthenticated;
  const prm = evidence.prm;

  // ------------------------------------------------------------- the challenge
  //
  // An authless server is a legitimate shape, not a failure. It answers the
  // unauthenticated probe successfully, and every OAuth requirement below is
  // then `not-applicable` rather than unmet.
  const authless =
    unauth !== undefined && unauth.status >= 200 && unauth.status < 300;

  if (!unauth || unauth.status === 0) {
    findings.push(
      notEvaluated(
        CHALLENGE_PRESENT,
        stamp,
        unauth?.error
          ? `the endpoint could not be reached: ${unauth.error}`
          : "the endpoint could not be reached",
      ),
    );
  } else if (authless) {
    findings.push(
      notApplicable(
        CHALLENGE_PRESENT,
        stamp,
        "the endpoint answered an unauthenticated initialize, so it does not authenticate users",
      ),
    );
  } else if (unauth.status === 401) {
    const challenge = unauth.wwwAuthenticate ?? unauth.metaWwwAuthenticate;
    findings.push(
      challenge
        ? // The suite already grades "a 401 carries a challenge". Citing it
          // rather than re-deciding it keeps the two from disagreeing.
          derivedFrom(
            satisfied(CHALLENGE_PRESENT, stamp, {
              header: unauth.wwwAuthenticate,
              meta: unauth.metaWwwAuthenticate,
            }),
            "oauth-conformance:oauth-401-www-authenticate",
          )
        : violated(
            CHALLENGE_PRESENT,
            stamp,
            "Answer an unauthenticated call with 401 and a WWW-Authenticate challenge naming the resource metadata.",
            { status: unauth.status },
          ),
    );
  } else {
    findings.push(
      violated(
        CHALLENGE_PRESENT,
        stamp,
        `An unauthenticated call answered ${unauth.status}; ChatGPT starts authorization from a 401 challenge.`,
        { status: unauth.status },
      ),
    );
  }

  // ---------------------------------------------------------------------- PRM
  if (authless) {
    for (const definition of [
      PRM_DISCOVERABLE,
      PRM_POINTER_USABLE,
      ALL_ISSUERS_RESOLVE,
      PKCE_S256,
      ISSUER_PARAMETER,
      CLIENT_ACQUISITION,
      UNSUPPORTED_FLOWS,
    ]) {
      findings.push(
        notApplicable(
          definition,
          stamp,
          "the endpoint does not authenticate users, so there is no authorization server to grade",
        ),
      );
    }
    findings.push(
      notApplicable(
        RUNTIME_CHALLENGE,
        stamp,
        "the endpoint does not authenticate users",
      ),
    );
    return findings;
  }

  // FETCHED AND ABSENT, or never fetched. `discoveredVia: "not-found"` is set
  // for both — the well-known path answered 404, and the host answered nothing
  // at all — and only the first is a missing document. The endpoint's own
  // unauthenticated probe is the tell: when THAT never landed, the PRM requests
  // went to the same host over the same transport and failed for the same
  // reason, so this run established nothing to grade. Reporting a `violated`
  // runtime-blocker there would tell a submitter to publish a document they may
  // already have published, and would do it on the strength of a network event.
  const endpointUnreached = !unauth || unauth.status === 0;

  if (!prm || prm.discoveredVia === "not-found") {
    if (endpointUnreached || prm?.fetchError) {
      findings.push(
        notEvaluated(
          PRM_DISCOVERABLE,
          stamp,
          prm?.fetchError
            ? `the resource metadata document could not be fetched: ${prm.fetchError}`
            : "the endpoint could not be reached, so its resource metadata was never fetched",
        ),
      );
    } else {
      findings.push(
        violated(
          PRM_DISCOVERABLE,
          stamp,
          "Publish a Protected Resource Metadata document at the well-known path for the endpoint.",
          { fetchError: prm?.fetchError },
        ),
      );
    }
  } else {
    findings.push(
      derivedFrom(
        satisfied(PRM_DISCOVERABLE, stamp, {
          discoveredVia: prm.discoveredVia,
          url: prm.url,
        }),
        "oauth-conformance:oauth-prm-discoverable",
      ),
    );
  }

  findings.push(
    prm?.rejectedPointer
      ? violated(
          PRM_POINTER_USABLE,
          stamp,
          "The challenge's resource_metadata pointer is off-origin or not http(s); no conforming client can follow it.",
          { rejectedPointer: prm.rejectedPointer },
        )
      : prm && prm.discoveredVia !== "not-found"
        ? satisfied(PRM_POINTER_USABLE, stamp, {
            discoveredVia: prm.discoveredVia,
          })
        : notEvaluated(
            PRM_POINTER_USABLE,
            stamp,
            "no Protected Resource Metadata document was found, so no pointer was followed",
          ),
  );

  // ---------------------------------------------------------- the issuers
  const servers = evidence.authorizationServers ?? [];
  const advertised = evidence.advertisedAuthorizationServerCount ?? 0;

  // THE FETCH IS BOUNDED, and a clean result over the issuers this run read is
  // not a clean result over the ones it did not. `authorization_servers` is
  // attacker-supplied in the only sense that matters here — it is a list the
  // submitted server chose — so the runner caps how many it will follow, and
  // a server advertising two hundred issuers of which the first five resolve
  // would otherwise pass "every advertised authorization server publishes
  // usable metadata" on the strength of five.
  //
  // WHICH SIDE the remainder can overturn depends on the quantifier. A
  // UNIVERSAL claim ("every issuer supports S256") is falsified by one
  // unfetched issuer, so its SATISFIED side is the provisional one. An
  // EXISTENTIAL claim ("some issuer offers registration") is established by
  // one, so its VIOLATED side is. Reporting either provisional side as a
  // verdict would be this report's cardinal sin: "did not run" reading as
  // "conformed".
  const untested = Math.max(0, advertised - servers.length);
  const untestedReason =
    `this run read ${servers.length} of the ${advertised} advertised ` +
    `authorization servers, so ${untested} were never fetched and the ` +
    `remainder could change this answer`;

  // A FETCHED ISSUER THAT PUBLISHED NOTHING IS ALSO UNREAD. Every feature check
  // below filters to `server.document` before deciding, so an issuer whose
  // metadata never arrived silently leaves the sample — and "no fetched issuer
  // is missing S256", said over a sample of one when three were advertised, is
  // not the claim the check's title makes. `ALL_ISSUERS_RESOLVE` reports those
  // issuers separately, but a reader reads findings, and this one must not say
  // `satisfied` about an issuer nobody read.
  const documentless = servers.filter((server) => !server.document);
  const unreadReason = `${documentless.length} of the fetched authorization servers published no metadata, so they were never graded: ${documentless
    .map((server) => server.issuer)
    .join(", ")}`;

  const overFetchedIssuers = (
    definition: OpenAICheckDefinition,
    conclusive: OpenAIReadinessFinding,
    overturnable: boolean,
  ): OpenAIReadinessFinding => {
    if (!overturnable) return conclusive;
    if (untested > 0) return notEvaluated(definition, stamp, untestedReason);
    if (documentless.length > 0) {
      return notEvaluated(definition, stamp, unreadReason);
    }
    return conclusive;
  };

  if (advertised === 0) {
    for (const definition of [
      ALL_ISSUERS_RESOLVE,
      PKCE_S256,
      ISSUER_PARAMETER,
    ]) {
      findings.push(
        notEvaluated(
          definition,
          stamp,
          "no Protected Resource Metadata document named an authorization server",
        ),
      );
    }
  } else {
    const unreachable = servers.filter((server) => !server.document);
    findings.push(
      unreachable.length === 0
        ? overFetchedIssuers(
            ALL_ISSUERS_RESOLVE,
            satisfied(ALL_ISSUERS_RESOLVE, stamp, {
              advertised,
              fetched: servers.length,
            }),
            true,
          )
        : violated(
            ALL_ISSUERS_RESOLVE,
            stamp,
            // NAMED, because "one issuer is unreachable" out of four sends a
            // submitter to check all four.
            `These advertised authorization servers published no usable metadata: ${unreachable
              .map((server) => server.issuer)
              .join(", ")}.`,
            {
              advertised,
              unreachable: unreachable.map((server) => ({
                issuer: server.issuer,
                fetchError: server.fetchError,
              })),
            },
          ),
    );

    const withoutS256 = servers
      .filter((server) => server.document)
      .filter(
        (server) =>
          !stringArray(
            server.document?.code_challenge_methods_supported,
          ).includes("S256"),
      );
    findings.push(
      withoutS256.length === 0
        ? overFetchedIssuers(
            PKCE_S256,
            derivedFrom(
              satisfied(PKCE_S256, stamp, { issuers: servers.length }),
              "oauth-conformance:oauth-pkce-s256",
            ),
            true,
          )
        : violated(
            PKCE_S256,
            stamp,
            `Advertise \`code_challenge_methods_supported: ["S256"]\` on: ${withoutS256
              .map((server) => server.issuer)
              .join(", ")}.`,
            { issuers: withoutS256.map((server) => server.issuer) },
          ),
    );

    // RFC 9207 matters HERE in a way it does not for a single-issuer host:
    // with several issuers a client cannot otherwise tell which one answered.
    const withoutIss = servers
      .filter((server) => server.document)
      .filter(
        (server) =>
          server.document?.authorization_response_iss_parameter_supported !==
          true,
      );
    findings.push(
      withoutIss.length === 0
        ? overFetchedIssuers(
            ISSUER_PARAMETER,
            satisfied(ISSUER_PARAMETER, stamp, { issuers: servers.length }),
            true,
          )
        : advertised > 1
          ? violated(
              ISSUER_PARAMETER,
              stamp,
              `Advertise \`authorization_response_iss_parameter_supported: true\` on: ${withoutIss
                .map((server) => server.issuer)
                .join(
                  ", ",
                )}. With more than one issuer a client cannot otherwise tell which one answered.`,
              { issuers: withoutIss.map((server) => server.issuer) },
            )
          : informational(
              ISSUER_PARAMETER,
              stamp,
              { issuers: withoutIss.map((server) => server.issuer) },
              "This server advertises a single issuer, so RFC 9207 is not load-bearing here; it becomes required if a second is added.",
            ),
    );

    // ------------------------------------------------ how a client gets an id
    const anyRegistration = servers.some(
      (server) => typeof server.document?.registration_endpoint === "string",
    );
    // Client ID Metadata Documents are the documented alternative to dynamic
    // registration: a server supporting either is usable without a human
    // pre-registering a client.
    const anyCimd = servers.some((server) =>
      stringArray(
        server.document?.client_id_metadata_document_supported_methods ??
          server.document?.client_registration_types_supported,
      ).some((method) => method.toLowerCase().includes("automatic")),
    );
    const cimdFlag =
      servers.some(
        (server) =>
          server.document?.client_id_metadata_document_supported === true,
      ) || anyCimd;

    findings.push(
      anyRegistration || cimdFlag
        ? satisfied(CLIENT_ACQUISITION, stamp, {
            dynamicRegistration: anyRegistration,
            clientIdMetadataDocuments: cimdFlag,
          })
        : // EXISTENTIAL, so it is the negative that the unfetched issuers can
          // overturn: one of them may be the issuer that offers registration.
          overFetchedIssuers(
            CLIENT_ACQUISITION,
            violated(
              CLIENT_ACQUISITION,
              stamp,
              "Support dynamic client registration or Client ID Metadata Documents; otherwise every install needs a manual pre-registration step.",
              { issuers: servers.map((server) => server.issuer) },
            ),
            true,
          ),
    );

    // -------------------------------------------------- flows that cannot work
    const requiredUnsupported = servers
      .filter((server) => server.document)
      .filter((server) => {
        const grants = stringArray(server.document?.grant_types_supported);
        // Only a problem when the authorization-code grant is ABSENT: a server
        // that offers client credentials ALONGSIDE it is fine, and flagging
        // that would fail a perfectly usable server.
        return (
          grants.length > 0 &&
          !grants.includes("authorization_code") &&
          grants.some((grant) => UNSUPPORTED_GRANT_TYPES.includes(grant))
        );
      });
    findings.push(
      requiredUnsupported.length === 0
        ? overFetchedIssuers(
            UNSUPPORTED_FLOWS,
            satisfied(UNSUPPORTED_FLOWS, stamp),
            true,
          )
        : violated(
            UNSUPPORTED_FLOWS,
            stamp,
            `These issuers offer no authorization-code grant, so a user-facing ChatGPT install cannot authenticate: ${requiredUnsupported
              .map((server) => server.issuer)
              .join(", ")}.`,
            {
              issuers: requiredUnsupported.map((server) => ({
                issuer: server.issuer,
                grantTypes: stringArray(server.document?.grant_types_supported),
              })),
            },
          ),
    );
  }

  // ------------------------------------------------------- runtime challenge
  findings.push(
    unauth?.metaWwwAuthenticate
      ? satisfied(RUNTIME_CHALLENGE, stamp, {
          metaWwwAuthenticate: unauth.metaWwwAuthenticate,
        })
      : notEvaluated(
          RUNTIME_CHALLENGE,
          stamp,
          'the initial probe carried no `_meta["mcp/www_authenticate"]`; a mid-session re-authorization is a state this run does not reach',
        ),
  );

  return findings;
}
