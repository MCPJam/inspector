import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  DEFAULT_IDENTITY_ASSERTION_FORMAT,
  DEFAULT_REGISTRATION_STRATEGY,
  normalizeIdentityAssertionFormat,
  normalizeRegistrationStrategy,
  type IdentityAssertionFormat,
  type RegistrationStrategy,
} from "@/shared/xaa.js";
import { deriveOAuthProfileFromServer } from "../oauth/utils";

// UI copy for the identity-assertion preset (input axis of the ID-JAG draft).
// One selector sets both axes at flow time: "saml" mints a SAML assertion AND
// asks for a saml-nameid `sub_id` on the ID-JAG; "oidc" keeps both defaults.
// Shared by the Configure-Server modal and the flow-header toggle so both
// surfaces describe the preset with identical words.
export const IDENTITY_ASSERTION_FORMAT_LABELS: Record<
  IdentityAssertionFormat,
  string
> = {
  oidc: "OIDC ID token",
  saml: "SAML assertion",
};

export const IDENTITY_ASSERTION_FORMAT_HINTS: Record<
  IdentityAssertionFormat,
  string
> = {
  oidc: "The MCPJam IdP mints an OIDC ID token as the identity assertion.",
  saml: "The MCPJam IdP mints a signed SAML 2.0 assertion; the ID-JAG carries a saml-nameid subject identifier.",
};

/**
 * The stored-server values the "Configure Server to Test" form edits — one
 * derivation shared by the modal's open-time seeding and the header format
 * toggle's untouched resave, so the two surfaces can never disagree about
 * what an unedited field holds.
 */
export interface XaaServerFormSeed {
  serverName: string;
  serverUrl: string;
  registrationStrategy: RegistrationStrategy;
  identityAssertionFormat: IdentityAssertionFormat;
  clientId: string;
  /** Space-separated (stored comma- or space-separated forms normalized). */
  scopes: string;
  authzIssuer: string;
  allowPathScopedIssuer: boolean;
  xaaSubject: string;
  xaaEmail: string;
}

export function deriveXaaServerFormSeed(
  server: ServerWithName | undefined
): XaaServerFormSeed {
  const derived = deriveOAuthProfileFromServer(server);
  return {
    serverName: server?.name ?? "",
    serverUrl: derived.serverUrl ?? "",
    registrationStrategy:
      normalizeRegistrationStrategy(server?.registrationMode) ??
      DEFAULT_REGISTRATION_STRATEGY,
    identityAssertionFormat:
      normalizeIdentityAssertionFormat(server?.xaaIdentityAssertionFormat) ??
      DEFAULT_IDENTITY_ASSERTION_FORMAT,
    clientId: derived.clientId ?? "",
    scopes: (derived.scopes ?? "").replace(/,/g, " ").trim(),
    authzIssuer: server?.xaaAuthzIssuer ?? "",
    allowPathScopedIssuer: server?.xaaAllowPathScopedIssuer === true,
    xaaSubject: server?.xaaSubject ?? "",
    xaaEmail: server?.xaaEmail ?? "",
  };
}

/** The space-separated scopes string as the save path's array form. */
export function splitXaaScopes(scopes: string): string[] {
  return scopes
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

export interface XaaServerFormInput {
  name: string;
  url: string;
  clientId: string;
  /** Typed replacement secret; "" leaves the saved secret untouched. */
  clientSecret: string;
  /** Clear toggle — a typed replacement always wins over Clear. */
  clearClientSecret: boolean;
  hasClientSecret: boolean | undefined;
  oauthScopes: string[];
  authzIssuer: string;
  allowPathScopedIssuer: boolean;
  /**
   * Atomic identity-override pair: untouched (dirty=false) omits both keys so
   * the save path preserves the stored values; an edited complete pair sends
   * both; an explicit clear sends both as "".
   */
  identity: { dirty: boolean; subject: string; email: string };
  identityAssertionFormat: IdentityAssertionFormat;
  /**
   * Unified registration mode — written ONLY on explicit user edit
   * (auto-clobber guard): an untouched selector omits the field so the
   * save-path `?? existing` merge preserves the stored value (which may be
   * "auto", shared with the OAuth flow).
   */
  registration: { dirty: boolean; strategy: RegistrationStrategy };
}

/**
 * The single ServerFormData shape every XAA-debugger save emits — the modal
 * submit and the header format toggle both build through here, so field
 * semantics (secret sentinels, preserve-by-omission) can't drift between them.
 */
export function buildXaaServerFormData(
  input: XaaServerFormInput
): ServerFormData {
  // A typed value replaces the saved secret; the Clear toggle removes it. A
  // typed replacement always wins over Clear (the save path rejects both).
  const trimmedSecret = input.clientSecret.trim();
  const submittedClearSecret = input.clearClientSecret && !trimmedSecret;

  return {
    name: input.name,
    type: "http",
    url: input.url,
    // Cross-App Access discriminator — identical to the /servers Connect
    // page so a server configured in either surface is unambiguously XAA and
    // editing it in one place never flips it back to plain OAuth.
    useXaa: true,
    useOAuth: false,
    authServerMode: "mcpjam",
    clientId: input.clientId,
    ...(trimmedSecret ? { clientSecret: trimmedSecret } : {}),
    ...(submittedClearSecret ? { clearClientSecret: true } : {}),
    hasClientSecret: input.hasClientSecret,
    oauthScopes: input.oauthScopes,
    // Always send the issuer (possibly empty) so clearing it persists.
    xaaAuthzIssuer: input.authzIssuer,
    xaaAllowPathScopedIssuer: input.allowPathScopedIssuer,
    ...(input.identity.dirty
      ? { xaaSubject: input.identity.subject, xaaEmail: input.identity.email }
      : {}),
    // Identity assertion preset — always sent (absent stored value = oidc).
    xaaIdentityAssertionFormat: input.identityAssertionFormat,
    ...(input.registration.dirty
      ? { registrationMode: input.registration.strategy }
      : {}),
  };
}

/**
 * The exact ServerFormData an untouched "Configure Server to Test" resave
 * would emit, with only the identity-assertion format changed — what the
 * flow-header OIDC/SAML toggle persists. Identity pair and registrationMode
 * stay omitted (preserve-by-omission), no secret sentinel is sent, so the
 * only stored value this save can change is the format.
 */
export function buildXaaAssertionFormatResave(
  server: ServerWithName,
  format: IdentityAssertionFormat
): ServerFormData {
  const seed = deriveXaaServerFormSeed(server);
  return buildXaaServerFormData({
    name: seed.serverName,
    url: seed.serverUrl,
    clientId: seed.clientId.trim(),
    clientSecret: "",
    clearClientSecret: false,
    hasClientSecret: server.hasClientSecret,
    oauthScopes: splitXaaScopes(seed.scopes),
    authzIssuer: seed.authzIssuer.trim(),
    allowPathScopedIssuer: seed.allowPathScopedIssuer,
    identity: { dirty: false, subject: "", email: "" },
    identityAssertionFormat: format,
    registration: { dirty: false, strategy: seed.registrationStrategy },
  });
}
