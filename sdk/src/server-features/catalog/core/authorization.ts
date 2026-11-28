/**
 * Family 17: Authorization for HTTP servers. Discovery metadata comes from
 * the read-only authorization probe; what only a real sign-in shows comes
 * from the connect OAuth flow summary. Stdio servers, and HTTP servers that
 * answer without authorization, make every row not applicable.
 */

import type { FeatureDefinition } from "../../types.js";
import { coreSpec } from "../spec-refs.js";
import {
  absent,
  asMetadataProbe,
  authProbe,
  authStdio,
  lifecycle,
  notApplicable,
  present,
  probeAbsent,
  probeBoolean,
  probeNumber,
  probeString,
  probeStrings,
  unknown,
} from "./rules.js";

const AUTHORIZATION = "basic/authorization";
const AS_DISCOVERY = "basic/authorization/authorization-server-discovery";
const REGISTRATION = "basic/authorization/client-registration";
const SECURITY = "basic/authorization/security-considerations";
const PRM_REQUIREMENTS = "protected-resource-metadata-discovery-requirements";
const MODERN = lifecycle({ introduced: "2026-07-28" });

/** Not applicable rows from the probe, nothing else. */
const authGate = authProbe();

export const AUTHORIZATION_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "auth.oauth",
    family: "core-authorization",
    name: "Authorization for HTTP servers",
    summary:
      "HTTP servers protect requests with OAuth. Stdio servers take credentials from their environment instead.",
    howTo:
      "Return 401 with a WWW-Authenticate challenge for requests without a valid token, and publish protected resource metadata.",
    owner: "server",
    spec: coreSpec("2026-07-28", AUTHORIZATION, "protocol-requirements"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: true,
    assessment: {
      primary: "probed",
      declared: authStdio,
      probed: authProbe((summary) => {
        if (probeBoolean(summary.values.oauthRequired) === true) {
          return present("probed", { detail: "Requires OAuth." });
        }
        return probeBoolean(summary.values.oauthOptional) === true
          ? present("probed", { detail: "Accepts OAuth when offered." })
          : null;
      }),
      oauthFlow: () => present("oauth-flow"),
    },
  },
  {
    id: "auth.resource-metadata-challenge",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "401 challenge with resource_metadata",
    summary:
      "The 401 response's WWW-Authenticate header points clients at the protected resource metadata.",
    howTo:
      "Add resource_metadata with an absolute URL to the Bearer challenge on every 401.",
    owner: "server",
    spec: coreSpec("2026-07-28", AS_DISCOVERY, PRM_REQUIREMENTS),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: true,
    assessment: {
      primary: "probed",
      declared: authStdio,
      probed: authProbe((summary) => {
        if (
          probeNumber(summary.values.nonCompliantChallengeStatus) !== undefined
        ) {
          return unknown(
            "The server sent its challenge with the wrong status code."
          );
        }
        const hasMetadata = probeBoolean(
          summary.values.challengeHasResourceMetadata
        );
        if (hasMetadata === true) return present("probed");
        return hasMetadata === false ? probeAbsent(summary) : null;
      }),
    },
  },
  {
    id: "auth.prm",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Protected resource metadata (RFC 9728)",
    summary:
      "A metadata document that names the server's authorization servers and the scopes it supports.",
    howTo:
      "Serve protected resource metadata with resource, authorization_servers and scopes_supported.",
    owner: "server",
    spec: coreSpec("2026-07-28", AS_DISCOVERY, "authorization-server-location"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: false,
    assessment: {
      primary: "probed",
      declared: authStdio,
      probed: authProbe((summary) => {
        const found = probeBoolean(summary.values.prmFound);
        if (found === true) {
          const servers =
            probeStrings(summary.values.prmAuthorizationServers) ?? [];
          return present("probed", { count: servers.length });
        }
        return found === false ? probeAbsent(summary) : null;
      }),
    },
  },
  {
    id: "auth.prm-well-known",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Metadata at the well-known path",
    summary:
      "Clients find the metadata at /.well-known/oauth-protected-resource, path first and then root, when the challenge does not name it.",
    howTo:
      "Serve the metadata at /.well-known/oauth-protected-resource plus your MCP path, and at the root as a fallback.",
    owner: "server",
    spec: coreSpec("2026-07-28", AS_DISCOVERY, "authorization-server-location"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25" }),
    optional: true,
    assessment: {
      primary: "probed",
      declared: authStdio,
      probed: authProbe((summary) => {
        const found = probeBoolean(summary.values.prmFound);
        if (found === false) return probeAbsent(summary);
        if (found !== true) return null;
        return probeBoolean(summary.values.challengeHasResourceMetadata) ===
          true
          ? unknown(
              "The challenge named the metadata URL, so the well-known path was not needed."
            )
          : present("probed", { detail: "Found at the well-known path." });
      }),
    },
  },
  {
    id: "auth.multiple-authorization-servers",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Multiple authorization servers",
    summary:
      "The metadata lists more than one authorization server, and the client picks one.",
    howTo:
      "List every authorization server that issues tokens for this server in authorization_servers.",
    owner: "server",
    spec: coreSpec("2026-07-28", AS_DISCOVERY, "authorization-server-location"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: true,
    assessment: {
      primary: "probed",
      declared: authStdio,
      probed: authProbe((summary) => {
        if (probeBoolean(summary.values.prmFound) !== true) return null;
        const servers =
          probeStrings(summary.values.prmAuthorizationServers) ?? [];
        if (servers.length > 1) {
          return present("advertised", { count: servers.length });
        }
        return servers.length === 1
          ? notApplicable("The server names one authorization server.")
          : null;
      }),
    },
  },
  {
    id: "auth.as-metadata",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Authorization server metadata",
    summary:
      "OAuth (RFC 8414) or OpenID Connect discovery metadata that lists the authorization server's endpoints.",
    howTo:
      "Publish /.well-known/oauth-authorization-server or /.well-known/openid-configuration on your authorization server.",
    owner: "authorization-server",
    spec: coreSpec(
      "2026-07-28",
      AS_DISCOVERY,
      "authorization-server-metadata-discovery"
    ),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: false,
    assessment: {
      primary: "probed",
      declared: authStdio,
      probed: authProbe((summary) => {
        const found = probeBoolean(summary.values.asMetadataFound);
        if (found === true) {
          const kind = probeString(summary.values.asMetadataKind);
          return present("probed", {
            detail:
              kind === "oidc" ? "OpenID Connect discovery." : "OAuth metadata.",
          });
        }
        return found === false ? probeAbsent(summary) : null;
      }),
    },
  },
  {
    id: "auth.fallback-endpoints",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Default endpoints without metadata",
    summary:
      "On 2025-03-26, clients fall back to /authorize, /token and /register when there is no metadata.",
    howTo:
      "Publish authorization server metadata instead. Later revisions removed the fallback.",
    owner: "server",
    spec: coreSpec("2025-03-26", AUTHORIZATION),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26", removed: "2025-06-18" }),
    optional: true,
    assessment: { primary: "probed", declared: authStdio, probed: authGate },
  },
  {
    id: "auth.issuer-validation",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Issuer matches the metadata",
    summary:
      "The metadata's issuer equals the authorization server URL the resource metadata names, so clients accept it.",
    howTo:
      "Set issuer in your authorization server metadata to exactly the URL listed in authorization_servers.",
    owner: "authorization-server",
    spec: coreSpec(
      "2026-07-28",
      AS_DISCOVERY,
      "authorization-server-metadata-discovery"
    ),
    stage: "stable",
    lifecycle: MODERN,
    optional: false,
    assessment: {
      primary: "probed",
      declared: authStdio,
      probed: asMetadataProbe((summary) => {
        const issuer = probeString(summary.values.issuer);
        const servers = probeStrings(summary.values.prmAuthorizationServers);
        if (!issuer || !servers || servers.length === 0) return null;
        return servers.includes(issuer)
          ? present("probed")
          : probeAbsent(
              summary,
              "The issuer differs from the listed authorization server."
            );
      }),
    },
  },
  {
    id: "auth.pkce",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "PKCE (S256)",
    summary:
      "The authorization server advertises S256 code challenges, which protect the code exchange.",
    howTo:
      "Support PKCE with S256 and list it in code_challenge_methods_supported.",
    owner: "authorization-server",
    spec: coreSpec("2026-07-28", SECURITY, "authorization-code-protection"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: false,
    assessment: {
      primary: "probed",
      declared: authStdio,
      probed: asMetadataProbe((summary) =>
        (probeStrings(summary.values.codeChallengeMethods) ?? []).includes(
          "S256"
        )
          ? present("advertised")
          : probeAbsent(summary)
      ),
    },
  },
  {
    id: "auth.cimd",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Client ID Metadata Documents",
    summary:
      "Clients use an HTTPS URL that describes them as their client_id, with no registration step.",
    howTo:
      "Accept URL client_ids and set client_id_metadata_document_supported to true in your metadata.",
    owner: "authorization-server",
    spec: coreSpec("2026-07-28", REGISTRATION, "advertising-cimd-support"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25" }),
    optional: true,
    assessment: {
      primary: "probed",
      declared: authStdio,
      probed: asMetadataProbe((summary) =>
        probeBoolean(summary.values.cimdSupported) === true
          ? present("advertised")
          : probeAbsent(summary)
      ),
    },
  },
  {
    id: "auth.dcr",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Dynamic Client Registration",
    summary:
      "Clients register themselves at a registration endpoint before signing in.",
    howTo:
      "Prefer Client ID Metadata Documents. If you keep registration, list registration_endpoint in your metadata.",
    owner: "authorization-server",
    spec: coreSpec("2026-07-28", REGISTRATION, "dynamic-client-registration"),
    stage: "stable",
    lifecycle: lifecycle({
      introduced: "2025-03-26",
      deprecated: "2026-07-28",
    }),
    optional: true,
    assessment: {
      primary: "probed",
      declared: authStdio,
      probed: asMetadataProbe((summary) =>
        probeBoolean(summary.values.registrationEndpoint) === true
          ? present("advertised")
          : probeAbsent(summary)
      ),
    },
  },
  {
    id: "auth.dcr-application-type",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Registration redirect URI rules",
    summary:
      "Registration checks application_type and accepts only localhost or HTTPS redirect URIs.",
    howTo:
      "Reject registrations whose redirect URIs are plain HTTP on a non-local host. Run the OAuth checks to test it.",
    owner: "authorization-server",
    spec: coreSpec(
      "2026-07-28",
      REGISTRATION,
      "application-type-and-redirect-uri-constraints"
    ),
    stage: "stable",
    lifecycle: MODERN,
    optional: false,
    assessment: { primary: "checked", declared: authStdio, probed: authGate },
  },
  {
    id: "auth.pre-registration",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Pre-registered clients",
    summary:
      "The operator registers a client ahead of time and gives the user its client ID and secret.",
    howTo:
      "Add the client ID and secret from your authorization server to the server's OAuth settings in MCPJam, then reconnect the account from the server's Auth tab.",
    owner: "authorization-server",
    spec: coreSpec("2026-07-28", REGISTRATION, "pre-registration"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: true,
    assessment: {
      primary: "configured",
      setup: "pre-registered-client",
      declared: authStdio,
      probed: authGate,
      oauthFlow: (summary) =>
        summary.registrationStrategy === "preregistered"
          ? present("oauth-flow")
          : null,
    },
  },
  {
    id: "auth.resource-indicators",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Resource indicators (RFC 8707)",
    summary:
      "The client names this server's canonical URI as the resource, so tokens are bound to it.",
    howTo:
      "Accept the resource parameter on authorization and token requests and issue tokens for that audience.",
    owner: "client",
    spec: coreSpec(
      "2026-07-28",
      AUTHORIZATION,
      "resource-parameter-implementation"
    ),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: false,
    assessment: {
      primary: "oauth-flow",
      declared: authStdio,
      probed: authGate,
      oauthFlow: (summary) =>
        summary.resourceIndicatorSent
          ? present("oauth-flow")
          : unknown(
              "MCPJam did not send a resource parameter in this sign-in."
            ),
    },
  },
  {
    id: "auth.scope-selection",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Scope selection",
    summary:
      "The client asks for the scopes in the challenge, or else the scopes the metadata lists.",
    howTo:
      "Put the scopes a request needs in the challenge's scope parameter and list all of them in scopes_supported.",
    owner: "client",
    spec: coreSpec("2026-07-28", AUTHORIZATION, "scope-selection-strategy"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25" }),
    optional: true,
    assessment: {
      primary: "oauth-flow",
      declared: authStdio,
      probed: authGate,
      oauthFlow: (summary) =>
        summary.scopesRequested.length > 0
          ? present("oauth-flow", { count: summary.scopesRequested.length })
          : unknown("The sign-in requested no scopes."),
    },
  },
  {
    id: "auth.step-up",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Step-up authorization",
    summary:
      "A request that needs more scopes gets 403 insufficient_scope, and the client signs in again for them.",
    howTo:
      "Return 403 with error insufficient_scope and the scopes needed in the WWW-Authenticate header.",
    owner: "server",
    spec: coreSpec("2026-07-28", AUTHORIZATION, "step-up-authorization-flow"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25" }),
    optional: true,
    assessment: { primary: "observed", declared: authStdio, probed: authGate },
  },
  {
    id: "auth.iss-parameter",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "iss in the authorization response (RFC 9207)",
    summary:
      "The authorization server names itself in the redirect, which stops mix-up attacks.",
    howTo:
      "Return iss on the authorization response and advertise authorization_response_iss_parameter_supported.",
    owner: "authorization-server",
    spec: coreSpec(
      "2026-07-28",
      AUTHORIZATION,
      "authorization-response-validation"
    ),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: {
      primary: "oauth-flow",
      declared: authStdio,
      probed: authGate,
      oauthFlow: (summary) =>
        summary.issReturned
          ? present("oauth-flow", {
              detail: summary.issValidated
                ? "Returned and validated."
                : "Returned.",
            })
          : absent([]),
    },
  },
  {
    id: "auth.issuer-binding",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Credentials bound to the issuer",
    summary:
      "The client keeps its registration and tokens per authorization server, so one issuer's credentials never reach another.",
    howTo:
      "Sign in through MCPJam. It records which issuer each set of credentials belongs to.",
    owner: "client",
    spec: coreSpec("2026-07-28", REGISTRATION, "authorization-server-binding"),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: {
      primary: "oauth-flow",
      declared: authStdio,
      probed: authGate,
      oauthFlow: (summary) =>
        summary.issuer
          ? present("oauth-flow")
          : unknown("The sign-in did not record an issuer."),
    },
  },
  {
    id: "auth.refresh-tokens",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Refresh tokens",
    summary:
      "The authorization server issues a refresh token, so the client stays signed in without asking the user again.",
    howTo:
      "Issue refresh tokens when the client asks for offline_access, and list offline_access in scopes_supported.",
    owner: "authorization-server",
    spec: coreSpec("2026-07-28", AUTHORIZATION, "refresh-tokens"),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: {
      primary: "oauth-flow",
      declared: authStdio,
      probed: authGate,
      oauthFlow: (summary) => {
        if (summary.refreshTokenIssued) return present("oauth-flow");
        return summary.scopesRequested.includes("offline_access")
          ? absent(
              [],
              "MCPJam asked for offline_access and got no refresh token."
            )
          : unknown("MCPJam did not ask for offline_access in this sign-in.");
      },
    },
  },
  {
    id: "auth.token-validation",
    family: "core-authorization",
    parent: "auth.oauth",
    name: "Token audience validation",
    summary:
      "The server accepts only tokens issued for it and never passes a client's token on to other services.",
    howTo:
      "Check each token's audience against your canonical URI and reject others with 401. Run the OAuth checks to test it.",
    owner: "server",
    spec: coreSpec(
      "2026-07-28",
      SECURITY,
      "token-audience-binding-and-validation"
    ),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: false,
    assessment: { primary: "checked", declared: authStdio, probed: authGate },
  },
];
