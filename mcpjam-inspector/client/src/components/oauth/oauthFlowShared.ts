import type {
  OAuthRegistrationStrategy,
  OAuthTestProfile,
} from "@/lib/oauth/profile";
import type { OAuthFlowStep } from "@/lib/oauth/state-machines/types";

export interface OAuthTokensFromFlow {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  clientId?: string;
  clientSecret?: string;
}

export type OAuthFlowExperienceTargetMode =
  | "server-backed"
  | "fixed-profile";

export interface OAuthFlowExperienceCapabilities {
  canConfigureTarget?: boolean;
  canEditTarget?: boolean;
  canApplyTokens?: boolean;
  canRefreshTokens?: boolean;
}

export interface OAuthFlowExperienceConfig {
  targetMode?: OAuthFlowExperienceTargetMode;
  capabilities?: OAuthFlowExperienceCapabilities;
  initialFocusedStep?: OAuthFlowStep | null;
  visibleStepRange?: {
    start?: OAuthFlowStep;
    end?: OAuthFlowStep;
  };
}

export interface OAuthFlowExperienceSummary {
  label: string;
  description: string;
  protocol?: string;
  registration?: string;
  step?: OAuthFlowStep;
  serverUrl?: string;
  scopes?: string;
  clientId?: string;
  customHeadersCount?: number;
}

export const deriveServerIdentifier = (profile: OAuthTestProfile): string => {
  const trimmedUrl = profile.serverUrl.trim();
  if (!trimmedUrl) {
    return "oauth-flow-target";
  }

  try {
    const url = new URL(trimmedUrl);
    return url.host;
  } catch {
    return trimmedUrl;
  }
};

export const buildHeaderMap = (
  headers: Array<{ key: string; value: string }>,
): Record<string, string> | undefined => {
  const entries = headers
    .map((header) => ({
      key: header.key.trim(),
      value: header.value.trim(),
    }))
    .filter((header) => header.key.length > 0);

  if (!entries.length) {
    return undefined;
  }

  return Object.fromEntries(entries.map(({ key, value }) => [key, value]));
};

export const describeRegistrationStrategy = (
  strategy: OAuthRegistrationStrategy | string,
): string => {
  if (strategy === "cimd") return "CIMD (URL-based)";
  if (strategy === "dcr") return "Dynamic (DCR)";
  return "Pre-registered";
};

export const resolveOAuthFlowExperienceCapabilities = (
  config?: OAuthFlowExperienceConfig,
): Required<OAuthFlowExperienceCapabilities> => {
  const targetMode = config?.targetMode ?? "server-backed";

  const defaults: Required<OAuthFlowExperienceCapabilities> =
    targetMode === "fixed-profile"
      ? {
          canConfigureTarget: false,
          canEditTarget: false,
          canApplyTokens: false,
          canRefreshTokens: false,
        }
      : {
          canConfigureTarget: true,
          canEditTarget: true,
          canApplyTokens: true,
          canRefreshTokens: true,
        };

  return {
    ...defaults,
    ...config?.capabilities,
  };
};
