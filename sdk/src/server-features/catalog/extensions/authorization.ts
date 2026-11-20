/**
 * Family 18: Authorization extensions (OAuth Client Credentials and
 * Enterprise-Managed Authorization). Neither extension defines a server
 * capability, so the authorization server's metadata is the cheapest hint.
 * The MCPJam app cannot run the client credentials grant, so those rows say
 * so and point at the CLI, which can. MCPJam does not record which auth a
 * connect used (an enterprise host advertises the XAA extension even on
 * connects that skip XAA), so no XAA row counts a connect yet. Like core
 * authorization, every leaf is not applicable on stdio.
 */

import type {
  FeatureDefinition,
  FeatureRuleOutcome,
  ProbeSurface,
} from "../../types.js";
import { authStdio } from "../core/rules.js";
import { extensionSpec } from "../spec-refs.js";
import {
  familyFeature,
  lookupExtension,
  probeBlocker,
  probeBoolean,
  probeStrings,
  specAt,
} from "./shared.js";

export const OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID =
  "io.modelcontextprotocol/oauth-client-credentials";
export const ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION_ID =
  "io.modelcontextprotocol/enterprise-managed-authorization";
export const ID_JAG_GRANT_PROFILE =
  "urn:ietf:params:oauth:grant-profile:id-jag";

const feature = familyFeature("authorization-extensions", "stable");

/**
 * Reads one list from the authorization probe. Unknown when the server uses
 * no OAuth, the metadata was not found, or the list is missing or empty
 * (RFC 8414 lists have defaults, so an empty list proves nothing).
 */
function authorizationList(
  probes: ProbeSurface,
  key:
    | "grantTypesSupported"
    | "tokenEndpointAuthMethods"
    | "authorizationGrantProfiles",
  field: string
): { list: readonly string[] } | { outcome: FeatureRuleOutcome } {
  const probe = probes.authorization;
  const blocked = probeBlocker(probe, "authorization metadata");
  if (blocked !== undefined || !probe) return { outcome: blocked ?? null };
  const values = probe.values;
  if (
    probeBoolean(values.oauthRequired) === false &&
    probeBoolean(values.oauthOptional) === false
  ) {
    return {
      outcome: {
        kind: "not-applicable",
        reason: "This server does not use OAuth.",
      },
    };
  }
  if (probeBoolean(values.asMetadataFound) !== true) {
    return {
      outcome: {
        kind: "unknown",
        reason: "No authorization server metadata was found.",
      },
    };
  }
  const list = probeStrings(values[key]);
  if (!list || list.length === 0) {
    return {
      outcome: {
        kind: "unknown",
        reason: `The authorization server metadata has no ${field}.`,
      },
    };
  }
  return { list };
}

function listContains(
  probes: ProbeSurface,
  key:
    | "grantTypesSupported"
    | "tokenEndpointAuthMethods"
    | "authorizationGrantProfiles",
  field: string,
  wanted: readonly string[]
): FeatureRuleOutcome {
  const read = authorizationList(probes, key, field);
  if ("outcome" in read) return read.outcome;
  const { list } = read;
  const found = wanted.filter((value) => list.includes(value));
  if (found.length > 0) {
    return {
      kind: "present",
      via: "advertised",
      detail: `${field} lists ${found.join(", ")}`,
    };
  }
  if (probes.authorization?.coverage !== "complete") {
    return {
      kind: "unknown",
      reason: "The authorization metadata was read only in part.",
    };
  }
  return {
    kind: "absent",
    basis: [],
    detail: `${field} lists ${list.join(", ")}`,
  };
}

export const AUTHORIZATION_EXTENSION_FEATURES: readonly FeatureDefinition[] = [
  feature({
    id: "auth-ext.client-credentials",
    name: "OAuth Client Credentials",
    summary: "Lets a machine client get tokens for the server without a user.",
    howTo:
      "Enable the client_credentials grant on your authorization server for MCP clients. The MCPJam app cannot run this grant yet; test it with mcpjam oauth login --url <server-url> --auth-mode client_credentials.",
    owner: "authorization-server",
    spec: specAt("client-credentials"),
    assessment: {
      primary: "configured",
      declared: authStdio,
      setup: "client-credentials",
    },
  }),
  feature({
    id: "auth-ext.client-credentials.grant",
    parent: "auth-ext.client-credentials",
    name: "client_credentials grant",
    summary:
      "The authorization server issues tokens to a client acting on its own behalf.",
    howTo:
      "List client_credentials in grant_types_supported and issue tokens for the MCP resource. The MCPJam app cannot run this grant yet; test it with mcpjam oauth login --url <server-url> --auth-mode client_credentials.",
    owner: "authorization-server",
    spec: specAt("client-credentials", "server-metadata-requirements"),
    assessment: {
      primary: "configured",
      declared: authStdio,
      setup: "client-credentials",
      probed: (probes) =>
        listContains(probes, "grantTypesSupported", "grant_types_supported", [
          "client_credentials",
        ]),
    },
  }),
  feature({
    id: "auth-ext.client-credentials.token-auth-methods",
    parent: "auth-ext.client-credentials",
    name: "token_endpoint_auth_methods_supported",
    summary:
      "Tells clients they can authenticate at the token endpoint with private_key_jwt or client_secret_basic.",
    howTo:
      "List private_key_jwt or client_secret_basic in token_endpoint_auth_methods_supported in your authorization server metadata.",
    owner: "authorization-server",
    spec: specAt("client-credentials", "server-metadata-requirements"),
    assessment: {
      primary: "probed",
      declared: authStdio,
      probed: (probes) =>
        listContains(
          probes,
          "tokenEndpointAuthMethods",
          "token_endpoint_auth_methods_supported",
          ["private_key_jwt", "client_secret_basic"]
        ),
    },
  }),
  feature({
    id: "auth-ext.client-credentials.token-request",
    parent: "auth-ext.client-credentials",
    name: "Client credentials token request",
    summary:
      "The client requests a token with its own credentials and calls the server with it.",
    howTo:
      "Issue the client a client id and secret. The MCPJam app cannot run this grant yet; test it with mcpjam oauth login --url <server-url> --auth-mode client_credentials, adding --registration preregistered --client-id <id> --client-secret <secret> for a pre-registered client.",
    owner: "client",
    spec: specAt("client-credentials", "flow-steps"),
    assessment: {
      primary: "configured",
      declared: authStdio,
      setup: "client-credentials",
    },
  }),
  feature({
    id: "auth-ext.xaa",
    name: "Enterprise-Managed Authorization (XAA)",
    summary:
      "Lets an enterprise identity provider grant access to the server through single sign-on.",
    howTo:
      "Accept ID-JAG assertions at your authorization server. MCPJam cannot record an XAA connect on this page yet.",
    owner: "authorization-server",
    spec: specAt("enterprise-managed-authorization"),
    assessment: {
      primary: "configured",
      declared: authStdio,
      setup: "enterprise-managed-authorization",
    },
  }),
  feature({
    id: "auth-ext.xaa.access",
    parent: "auth-ext.xaa",
    name: "Enterprise-managed access",
    summary:
      "A user signed in to the enterprise identity provider reaches the server without a separate consent screen.",
    howTo:
      "Accept access tokens for users the enterprise identity provider signs in. MCPJam cannot record an XAA connect on this page yet.",
    owner: "authorization-server",
    spec: specAt("enterprise-managed-authorization"),
    assessment: {
      primary: "configured",
      declared: authStdio,
      setup: "enterprise-managed-authorization",
    },
  }),
  feature({
    id: "auth-ext.xaa.id-jag-profile",
    parent: "auth-ext.xaa",
    name: "ID-JAG grant profile",
    summary:
      "The authorization server advertises that it accepts Identity Assertion JWT Authorization Grants.",
    howTo:
      "List urn:ietf:params:oauth:grant-profile:id-jag in authorization_grant_profiles_supported in your authorization server metadata.",
    owner: "authorization-server",
    spec: specAt("enterprise-managed-authorization", "6-discovery"),
    assessment: {
      primary: "probed",
      declared: authStdio,
      probed: (probes) =>
        listContains(
          probes,
          "authorizationGrantProfiles",
          "authorization_grant_profiles_supported",
          [ID_JAG_GRANT_PROFILE]
        ),
    },
  }),
  feature({
    id: "auth-ext.xaa.token-exchange",
    parent: "auth-ext.xaa",
    name: "Identity provider token exchange",
    summary:
      "The identity provider exchanges the user's ID token for an ID-JAG (RFC 8693).",
    howTo:
      "Configure token exchange for ID-JAG on your identity provider.",
    owner: "identity-provider",
    spec: specAt("enterprise-managed-authorization", "4-token-exchange"),
    assessment: {
      primary: "configured",
      declared: authStdio,
      setup: "enterprise-managed-authorization",
    },
  }),
  feature({
    id: "auth-ext.xaa.jwt-bearer",
    parent: "auth-ext.xaa",
    name: "JWT bearer access token request",
    summary:
      "The resource authorization server trades an ID-JAG for an access token with the JWT bearer grant.",
    howTo:
      "Accept the urn:ietf:params:oauth:grant-type:jwt-bearer grant with ID-JAG assertions at your authorization server.",
    owner: "authorization-server",
    spec: specAt("enterprise-managed-authorization", "5-access-token-request"),
    assessment: {
      primary: "configured",
      declared: authStdio,
      setup: "enterprise-managed-authorization",
    },
  }),
  feature({
    id: "auth-ext.xaa.saml",
    parent: "auth-ext.xaa",
    name: "SAML assertion to ID-JAG",
    summary:
      "An identity provider that uses SAML issues a refresh token, then an ID-JAG, for the user.",
    howTo:
      "Configure the SAML exchange on your identity provider.",
    owner: "identity-provider",
    spec: specAt("enterprise-managed-authorization", "4-token-exchange"),
    assessment: {
      primary: "configured",
      declared: authStdio,
      setup: "enterprise-managed-authorization",
    },
  }),
  feature({
    id: "auth-ext.discover-extension-ids",
    name: "Authorization extension ids in server/discover",
    summary:
      "The server names the authorization extensions it accepts in its extensions map.",
    howTo:
      "Add io.modelcontextprotocol/oauth-client-credentials or io.modelcontextprotocol/enterprise-managed-authorization to the extensions your server declares.",
    spec: extensionSpec("ext-auth", "auth/overview"),
    lifecycle: { introduced: "2026-07-28" },
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const stdio = authStdio(surface);
        if (stdio) return stdio;
        const declared = [
          OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID,
          ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION_ID,
        ].filter((id) => lookupExtension(surface, id).state === "declared");
        if (declared.length > 0) {
          return {
            kind: "present",
            via: "advertised",
            detail: declared.join(", "),
          };
        }
        // The extensions define no server capability, so a missing id is
        // never a gap.
        return {
          kind: "unknown",
          reason:
            "The authorization extensions define no server capability, so a missing id proves nothing.",
        };
      },
    },
  }),
];
