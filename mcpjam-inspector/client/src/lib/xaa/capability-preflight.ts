import type { XAAFlowState } from "./types";

export const JWT_BEARER_GRANT =
  "urn:ietf:params:oauth:grant-type:jwt-bearer";

// The ID-JAG draft's own discovery signal: a resource authorization server
// advertises end-to-end XAA support by listing this grant profile in
// authorization_grant_profiles_supported.
export const ID_JAG_GRANT_PROFILE = "urn:ietf:params:oauth:grant-profile:id-jag";

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
  id: "jwt_bearer_grant" | "token_endpoint" | "id_jag_grant_profile";
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
  authzMetadata: XAAFlowState["authzMetadata"],
): XAACompatibilityReport | null {
  if (!authzMetadata) return null;

  const grantTypesAdvertised = Array.isArray(
    authzMetadata.grant_types_supported,
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

  const grantProfilesAdvertised = Array.isArray(
    authzMetadata.authorization_grant_profiles_supported,
  );
  const grantProfiles = grantProfilesAdvertised
    ? (authzMetadata.authorization_grant_profiles_supported as string[])
    : [];
  const idJagProfileCheck: XAACompatibilityCheck = grantProfilesAdvertised
    ? grantProfiles.includes(ID_JAG_GRANT_PROFILE)
      ? {
          id: "id_jag_grant_profile",
          label: "ID-JAG grant profile",
          status: "pass",
          detail: `Advertised in authorization_grant_profiles_supported — the authorization server declares end-to-end XAA support.`,
        }
      : {
          id: "id_jag_grant_profile",
          label: "ID-JAG grant profile",
          status: "warn",
          detail: `authorization_grant_profiles_supported is advertised but does not include ${ID_JAG_GRANT_PROFILE}. The jwt-bearer redemption may still work, but the server hasn't declared XAA support.`,
        }
    : {
        id: "id_jag_grant_profile",
        label: "ID-JAG grant profile",
        status: "unknown",
        detail:
          "authorization_grant_profiles_supported is not in the discovery metadata. The parameter is new (ID-JAG draft), so its absence doesn't indicate a lack of support.",
      };

  const checks = [jwtBearerCheck, tokenEndpointCheck, idJagProfileCheck];

  const vendor = detectVendor(authzMetadata.issuer);
  const vendorHint = VENDOR_NOTES[vendor];

  // The grant-profile check's "unknown" (parameter absent) is excluded from
  // the overall verdict: the draft says this metadata MUST NOT be read as an
  // issuer allow-list, and virtually no AS publishes it yet — an absent param
  // must never flip an otherwise-green report to amber.
  const scoredChecks = checks.filter(
    (c) => !(c.id === "id_jag_grant_profile" && c.status === "unknown"),
  );

  let overall: XAACompatibilityVerdict = "pass";
  if (scoredChecks.some((c) => c.status === "fail")) {
    overall = "fail";
  } else if (
    scoredChecks.some((c) => c.status === "warn" || c.status === "unknown")
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
