import type { ServerWithName } from "@/hooks/use-app-state";
import type { HttpServerConfig } from "@mcpjam/sdk/browser";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  isNegativeTestMode,
  type NegativeTestMode,
} from "@/shared/xaa.js";

const XAA_PROFILE_STORAGE_KEY = "mcpjam-xaa-debugger-profile/v1";

export interface XAADebugProfile {
  serverUrl: string;
  authzServerIssuer: string;
  clientId: string;
  scope: string;
  userId: string;
  email: string;
  negativeTestMode: NegativeTestMode;
}

export const EMPTY_XAA_DEBUG_PROFILE: XAADebugProfile = {
  serverUrl: "",
  authzServerIssuer: "",
  clientId: "",
  scope: "",
  userId: "user-12345",
  email: "demo.user@example.com",
  negativeTestMode: DEFAULT_NEGATIVE_TEST_MODE,
};

function toUrlString(value?: string | URL): string {
  if (!value) return "";
  if (typeof value === "string") return value;

  try {
    return value.toString();
  } catch {
    return "";
  }
}

function sanitizeNegativeTestMode(value: unknown): NegativeTestMode {
  return isNegativeTestMode(value) ? value : DEFAULT_NEGATIVE_TEST_MODE;
}

export function loadStoredXAADebugProfile(): XAADebugProfile {
  try {
    const raw = localStorage.getItem(XAA_PROFILE_STORAGE_KEY);
    if (!raw) {
      return EMPTY_XAA_DEBUG_PROFILE;
    }

    const parsed = JSON.parse(raw) as Partial<XAADebugProfile>;
    return {
      ...EMPTY_XAA_DEBUG_PROFILE,
      ...parsed,
      negativeTestMode: sanitizeNegativeTestMode(parsed.negativeTestMode),
    };
  } catch {
    return EMPTY_XAA_DEBUG_PROFILE;
  }
}

export function saveStoredXAADebugProfile(profile: XAADebugProfile): void {
  try {
    localStorage.setItem(XAA_PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Ignore storage failures.
  }
}

export function deriveXAADebugProfileFromServer(
  server?: ServerWithName,
  existingProfile: XAADebugProfile = EMPTY_XAA_DEBUG_PROFILE,
): XAADebugProfile {
  if (!server) {
    return existingProfile;
  }

  const httpConfig =
    "url" in server.config ? (server.config as HttpServerConfig) : null;

  if (!httpConfig) {
    return existingProfile;
  }

  const configuredScopes = Array.isArray((httpConfig as any).oauthScopes)
    ? ((httpConfig as any).oauthScopes as string[]).join(" ")
    : "";
  const configuredClientId =
    typeof (httpConfig as any).clientId === "string"
      ? (httpConfig as any).clientId
      : "";

  return {
    ...EMPTY_XAA_DEBUG_PROFILE,
    ...existingProfile,
    serverUrl: existingProfile.serverUrl || toUrlString(httpConfig.url),
    clientId: existingProfile.clientId || configuredClientId,
    scope: existingProfile.scope || configuredScopes,
    negativeTestMode: sanitizeNegativeTestMode(
      existingProfile.negativeTestMode,
    ),
  };
}
