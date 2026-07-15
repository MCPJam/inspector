import {
  ID_JAG_GRANT_PROFILE,
  JWT_BEARER_GRANT,
} from "../../oauth/client-identity.js";
import type { XAAFlowState, XaaTokenEndpointAuthMethod } from "./types.js";
import type { XaaCapabilityEvidence } from "../mcp-init.js";

// Re-exported for existing consumers; the URN itself now has a single source
// of truth in the SDK.
export { JWT_BEARER_GRANT };

export type XAAVendor =
  | "okta"
  | "auth0"
  | "workos"
  | "stytch"
  | "keycloak"
  | "unknown";

export type XAAVendorVerdict = "native" | "unknown" | "unsupported";

export interface XAAVendorHint {
  vendor: XAAVendor;
  verdict: XAAVendorVerdict;
  note: string;
}

export type XAACheckStatus = "pass" | "fail" | "warn" | "unknown";

export interface XAACompatibilityCheck {
  id:
    | "jwt_bearer_grant"
    | "token_endpoint"
    | "id_jag_profile"
    | "cimd_supported";
  label: string;
  status: XAACheckStatus;
  detail: string;
}

export type XAACompatibilityVerdict = "pass" | "fail" | "warn";

export interface XAACompatibilityReport {
  overall: XAACompatibilityVerdict;
  checks: XAACompatibilityCheck[];
  vendor: XAAVendor;
  vendorHint?: XAAVendorHint;
}

export function detectVendor(issuer: string | undefined): XAAVendor {
  if (!issuer) return "unknown";
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return "unknown";
  }
  const host = url.hostname.toLowerCase();
  if (
    host.endsWith(".okta.com") ||
    host.endsWith(".oktapreview.com") ||
    host.endsWith(".okta-emea.com")
  ) {
    return "okta";
  }
  if (host.endsWith(".auth0.com")) {
    return "auth0";
  }
  if (host.endsWith(".workos.com") || host.endsWith(".authkit.app")) {
    return "workos";
  }
  if (host.endsWith(".stytch.com") || host.endsWith(".stytch.dev")) {
    return "stytch";
  }
  if (url.pathname.includes("/realms/") || host.startsWith("keycloak.")) {
    return "keycloak";
  }
  return "unknown";
}

const VENDOR_NOTES: Partial<Record<XAAVendor, XAAVendorHint>> = {
  okta: {
    vendor: "okta",
    verdict: "native",
    note: "Okta drove the Cross-App Access spec and supports the jwt-bearer grant natively. In your Okta admin console, register MCPJam as a trusted identity issuer using the JWKS URL from Register Issuer.",
  },
  auth0: {
    vendor: "auth0",
    verdict: "unknown",
    note: "Auth0 supports the jwt-bearer grant (RFC 7523). You'll need to configure a trusted issuer pointing at MCPJam's JWKS URL and map subjects to Auth0 users.",
  },
  keycloak: {
    vendor: "keycloak",
    verdict: "unknown",
    note: "Keycloak supports Token Exchange. Configure a brokered IdP that trusts MCPJam's JWKS and maps claims to realm users.",
  },
  workos: {
    vendor: "workos",
    verdict: "unsupported",
    note: "WorkOS AuthKit doesn't currently advertise the jwt-bearer grant or federated issuer trust. Workaround: run a small bridge service that verifies the ID-JAG against MCPJam's JWKS and mints access tokens via the WorkOS admin API.",
  },
  stytch: {
    vendor: "stytch",
    verdict: "unsupported",
    note: "Stytch Connected Apps doesn't currently advertise the jwt-bearer grant. A bridge service is the current workaround; ask Stytch support about roadmap plans for XAA.",
  },
};

export function analyzeAsCompatibility(
  authzMetadata: XAAFlowState["authzMetadata"]
): XAACompatibilityReport | null {
  if (!authzMetadata) return null;

  const grantTypesAdvertised = Array.isArray(
    authzMetadata.grant_types_supported
  );
  const grantTypes = grantTypesAdvertised
    ? (authzMetadata.grant_types_supported as string[])
    : [];
  const advertisesJwtBearer = grantTypes.includes(JWT_BEARER_GRANT);

  const jwtBearerCheck: XAACompatibilityCheck = advertisesJwtBearer
    ? {
        id: "jwt_bearer_grant",
        label: "JWT-bearer grant (RFC 7523)",
        status: "pass",
        detail: `Advertised in grant_types_supported.`,
      }
    : !grantTypesAdvertised
      ? {
          id: "jwt_bearer_grant",
          label: "JWT-bearer grant (RFC 7523)",
          status: "unknown",
          detail:
            "grant_types_supported is missing from discovery metadata. Support can't be verified without calling the token endpoint.",
        }
      : {
          id: "jwt_bearer_grant",
          label: "JWT-bearer grant (RFC 7523)",
          status: "fail",
          detail:
            grantTypes.length === 0
              ? "grant_types_supported is an empty array; the authorization server declares no supported grant types."
              : `grant_types_supported does not include ${JWT_BEARER_GRANT}. The authorization server will reject the ID-JAG exchange at step 11.`,
        };

  const hasTokenEndpoint = Boolean(authzMetadata.token_endpoint);
  const tokenEndpointCheck: XAACompatibilityCheck = hasTokenEndpoint
    ? {
        id: "token_endpoint",
        label: "Token endpoint",
        status: "pass",
        detail: authzMetadata.token_endpoint!,
      }
    : {
        id: "token_endpoint",
        label: "Token endpoint",
        status: "fail",
        detail: "Missing from discovery metadata.",
      };

  // Draft-04 ID-JAG grant profile advertisement. SHOULD, not MUST — so an
  // absent property is a warning; only an explicitly-present list WITHOUT the
  // profile is an explicit statement of non-support.
  const profilesValue = authzMetadata.authorization_grant_profiles_supported;
  const idJagProfileCheck: XAACompatibilityCheck = Array.isArray(profilesValue)
    ? profilesValue.includes(ID_JAG_GRANT_PROFILE)
      ? {
          id: "id_jag_profile",
          label: "ID-JAG grant profile (draft -04)",
          status: "pass",
          detail: "Advertised in authorization_grant_profiles_supported.",
        }
      : {
          id: "id_jag_profile",
          label: "ID-JAG grant profile (draft -04)",
          status: "fail",
          detail: `authorization_grant_profiles_supported is advertised but does not include ${ID_JAG_GRANT_PROFILE} — an explicit statement that the ID-JAG profile is unsupported.`,
        }
    : {
        id: "id_jag_profile",
        label: "ID-JAG grant profile (draft -04)",
        status: "warn",
        detail:
          "authorization_grant_profiles_supported is not advertised. Draft -04 says SHOULD, so this is a conformance warning, not a failure.",
      };

  // CIMD advertisement. Informational unless the cimd strategy is selected —
  // the flow itself parks on false/absent when it is (that park IS the
  // finding), so this check never degrades the overall verdict.
  const cimdValue = authzMetadata.client_id_metadata_document_supported;
  const cimdCheck: XAACompatibilityCheck =
    cimdValue === true
      ? {
          id: "cimd_supported",
          label: "Client ID Metadata Documents",
          status: "pass",
          detail: "client_id_metadata_document_supported: true.",
        }
      : cimdValue === false
        ? {
            id: "cimd_supported",
            label: "Client ID Metadata Documents",
            status: "fail",
            detail:
              "client_id_metadata_document_supported is explicitly false — URL-formatted client_ids are not accepted.",
          }
        : {
            id: "cimd_supported",
            label: "Client ID Metadata Documents",
            status: "unknown",
            detail:
              "client_id_metadata_document_supported is not advertised; the CIMD draft directs clients not to attempt the flow.",
          };

  const checks = [
    jwtBearerCheck,
    tokenEndpointCheck,
    idJagProfileCheck,
    cimdCheck,
  ];

  const vendor = detectVendor(authzMetadata.issuer);
  const vendorHint = VENDOR_NOTES[vendor];

  // Overall verdict: the core operational checks plus an EXPLICIT ID-JAG
  // profile contradiction. An absent profile advertisement (warn) and the
  // CIMD check are strategy/conformance signals and deliberately don't
  // degrade the overall readiness verdict.
  const coreChecks = [jwtBearerCheck, tokenEndpointCheck];
  let overall: XAACompatibilityVerdict = "pass";
  if (
    coreChecks.some((c) => c.status === "fail") ||
    idJagProfileCheck.status === "fail"
  ) {
    overall = "fail";
  } else if (
    coreChecks.some((c) => c.status === "warn" || c.status === "unknown")
  ) {
    overall = "warn";
  }

  if (vendorHint?.verdict === "unsupported") {
    overall = "fail";
  }

  return {
    overall,
    checks,
    vendor,
    vendorHint,
  };
}

/** Tri-state advertisement evidence for a single capability URN in AS
 * metadata: an absent array is `unknown` (the server didn't say), a present
 * array is `advertised`/`not_advertised` by membership. */
function capabilityEvidence(
  value: unknown,
  expected: string
): XaaCapabilityEvidence {
  if (value === undefined || value === null) return "unknown";
  return Array.isArray(value) && value.includes(expected)
    ? "advertised"
    : "not_advertised";
}

/** Flat ID-JAG-profile / jwt-bearer-grant advertisement evidence derived from
 * authorization-server metadata. Single source shared by the engine and the
 * CLI's result projection so the two never drift. */
export function deriveCapabilityEvidence(
  authzMetadata: XAAFlowState["authzMetadata"]
): {
  idJagProfile: XaaCapabilityEvidence;
  jwtBearerGrant: XaaCapabilityEvidence;
} {
  return {
    idJagProfile: capabilityEvidence(
      authzMetadata?.authorization_grant_profiles_supported,
      ID_JAG_GRANT_PROFILE
    ),
    jwtBearerGrant: capabilityEvidence(
      authzMetadata?.grant_types_supported,
      JWT_BEARER_GRANT
    ),
  };
}

/** Select the token-endpoint client-auth method for the jwt-bearer redemption.
 * Precedence: an explicit choice wins; with no client secret the client is
 * public (`none`); otherwise prefer the advertised method
 * (basic → post → none); when metadata is absent, default to
 * `client_secret_post`. Single source shared by the engine (pre-registered
 * discovery) and the CLI result projection. */
export function selectTokenEndpointAuthMethod(
  explicit: XaaTokenEndpointAuthMethod | undefined,
  clientSecret: string | undefined,
  advertised: unknown
): XaaTokenEndpointAuthMethod {
  if (explicit) return explicit;
  if (!clientSecret) return "none";
  if (Array.isArray(advertised)) {
    if (advertised.includes("client_secret_basic")) {
      return "client_secret_basic";
    }
    if (advertised.includes("client_secret_post")) {
      return "client_secret_post";
    }
    if (advertised.includes("none")) return "none";
  }
  return "client_secret_post";
}
