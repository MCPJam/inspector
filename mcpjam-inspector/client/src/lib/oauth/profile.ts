import type {
  OAuthProtocolVersion,
  RegistrationStrategy2025_03_26,
  RegistrationStrategy2025_06_18,
  RegistrationStrategy2025_11_25,
  RegistrationStrategy2026_07_28,
} from "@mcpjam/sdk/browser";

export type OAuthRegistrationStrategy =
  | RegistrationStrategy2025_03_26
  | RegistrationStrategy2025_06_18
  | RegistrationStrategy2025_11_25
  | RegistrationStrategy2026_07_28;

export interface OAuthTestProfile {
  serverUrl: string;
  resourceUrl?: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  customHeaders: Array<{ key: string; value: string }>;
  protocolVersion: OAuthProtocolVersion;
  registrationStrategy: OAuthRegistrationStrategy;
}

export const EMPTY_OAUTH_TEST_PROFILE: OAuthTestProfile = {
  serverUrl: "",
  resourceUrl: "",
  clientId: "",
  clientSecret: "",
  scopes: "",
  customHeaders: [],
  protocolVersion: "2025-11-25",
  registrationStrategy: "dcr",
};

const OAUTH_PROTOCOL_VERSIONS: readonly OAuthProtocolVersion[] = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

const OAUTH_REGISTRATION_STRATEGIES: readonly OAuthRegistrationStrategy[] = [
  "cimd",
  "dcr",
  "preregistered",
];

/**
 * The Convex `servers` columns backing these are plain strings (so an older
 * or newer client never fails the whole server save over an unknown value) —
 * narrow them back to the closed unions here; anything unrecognized reads as
 * absent and falls to the profile defaults.
 */
export function normalizeOAuthProtocolVersion(
  value: unknown,
): OAuthProtocolVersion | undefined {
  return OAUTH_PROTOCOL_VERSIONS.find((known) => known === value);
}

export function normalizeOAuthRegistrationStrategy(
  value: unknown,
): OAuthRegistrationStrategy | undefined {
  return OAUTH_REGISTRATION_STRATEGIES.find((known) => known === value);
}
