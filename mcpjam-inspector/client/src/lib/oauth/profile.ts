import type {
  OAuthProtocolVersion,
  RegistrationStrategy2025_03_26,
  RegistrationStrategy2025_06_18,
  RegistrationStrategy2025_11_25,
} from "@/lib/oauth/state-machines/types";

export type OAuthRegistrationStrategy =
  | RegistrationStrategy2025_03_26
  | RegistrationStrategy2025_06_18
  | RegistrationStrategy2025_11_25;

export interface OAuthTestProfile {
  serverUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  customHeaders: Array<{ key: string; value: string }>;
  protocolVersion: OAuthProtocolVersion;
  registrationStrategy: OAuthRegistrationStrategy;
}

export const EMPTY_OAUTH_TEST_PROFILE: OAuthTestProfile = {
  serverUrl: "",
  clientId: "",
  clientSecret: "",
  scopes: "",
  customHeaders: [],
  protocolVersion: "2025-11-25",
  registrationStrategy: "cimd",
};
