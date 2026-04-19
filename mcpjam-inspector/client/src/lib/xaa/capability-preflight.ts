import type { XAAFlowState } from "./types";

export const JWT_BEARER_GRANT =
  "urn:ietf:params:oauth:grant-type:jwt-bearer";

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
  id: "jwt_bearer_grant" | "token_endpoint";
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

  const checks = [jwtBearerCheck, tokenEndpointCheck];

  const vendor = detectVendor(authzMetadata.issuer);
  const vendorHint = VENDOR_NOTES[vendor];

  let overall: XAACompatibilityVerdict = "pass";
  if (checks.some((c) => c.status === "fail")) {
    overall = "fail";
  } else if (checks.some((c) => c.status === "warn" || c.status === "unknown")) {
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
