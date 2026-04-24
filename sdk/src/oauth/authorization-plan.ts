import { DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL } from "./client-identity.js";
import {
  canonicalizeResourceUrl,
} from "./state-machines/shared/urls.js";
import type {
  OAuthAuthMode,
  OAuthProtocolVersion,
  RegistrationStrategy2025_03_26,
  RegistrationStrategy2025_06_18,
  RegistrationStrategy2025_11_25,
} from "./state-machines/types.js";

export type OAuthRegistrationStrategy =
  | RegistrationStrategy2025_03_26
  | RegistrationStrategy2025_06_18
  | RegistrationStrategy2025_11_25;

export type OAuthProtocolMode = "auto" | OAuthProtocolVersion;
export type OAuthRegistrationMode = "auto" | OAuthRegistrationStrategy;

export interface AuthorizationDiscoverySnapshot {
  registrationStrategies?: Array<"preregistered" | "dcr" | "cimd">;
  authorizationServerMetadataUrl?: string;
  authorizationServerMetadata?: Record<string, unknown>;
  resourceMetadataUrl?: string;
  resourceMetadata?: Record<string, unknown>;
  discoveryError?: string;
}

export interface AuthorizationPlanInput {
  serverUrl?: string;
  protocolMode?: OAuthProtocolMode;
  protocolVersion?: OAuthProtocolVersion;
  registrationMode?: OAuthRegistrationMode;
  registrationStrategy?: OAuthRegistrationStrategy;
  clientId?: string;
  clientSecret?: string;
  clientIdMetadataUrl?: string;
  useRegistryOAuthProxy?: boolean;
  authMode?: OAuthAuthMode;
  discovery?: AuthorizationDiscoverySnapshot;
}

export interface AuthorizationPlanCapabilities {
  registrationStrategies: Array<"preregistered" | "dcr" | "cimd">;
  supportsCimd: boolean;
  supportsDcr: boolean;
  authorizationServerMetadataUrl?: string;
  resourceMetadataUrl?: string;
  discoveryError?: string;
}

export interface ResolvedAuthorizationPlan {
  protocolMode: OAuthProtocolMode;
  protocolVersion: OAuthProtocolVersion;
  registrationMode: OAuthRegistrationMode;
  registrationStrategy?: OAuthRegistrationStrategy;
  status: "ready" | "discovery_required" | "blocked";
  blockers: string[];
  warnings: string[];
  capabilities: AuthorizationPlanCapabilities;
  canonicalResource?: string;
  clientIdMetadataUrl?: string;
  summary: string;
}

function normalizeProtocolMode(
  input: Pick<AuthorizationPlanInput, "protocolMode" | "protocolVersion">,
): OAuthProtocolMode {
  if (input.protocolMode) {
    return input.protocolMode;
  }

  return input.protocolVersion ?? "auto";
}

function normalizeRegistrationMode(
  input: Pick<
    AuthorizationPlanInput,
    "registrationMode" | "registrationStrategy"
  >,
): OAuthRegistrationMode {
  if (input.registrationMode) {
    return input.registrationMode;
  }

  return input.registrationStrategy ?? "auto";
}

function resolveProtocolVersion(
  input: Pick<AuthorizationPlanInput, "protocolMode" | "protocolVersion">,
): OAuthProtocolVersion {
  if (input.protocolVersion) {
    return input.protocolVersion;
  }

  if (input.protocolMode && input.protocolMode !== "auto") {
    return input.protocolMode;
  }

  return "2025-11-25";
}

function normalizeClientIdMetadataUrl(url?: string): string | undefined {
  const trimmed = url?.trim();
  return trimmed ? trimmed : undefined;
}

function summarizePlan(
  status: ResolvedAuthorizationPlan["status"],
  registrationStrategy: OAuthRegistrationStrategy | undefined,
  blockers: string[],
  warnings: string[],
  capabilities: AuthorizationPlanCapabilities,
): string {
  if (status === "blocked") {
    return blockers[0] ?? "OAuth authorization is blocked.";
  }

  if (status === "discovery_required") {
    return "Automatic discovery will choose pre-registered credentials, CIMD, or DCR after the server is probed.";
  }

  if (registrationStrategy === "preregistered") {
    return "Using pre-registered client credentials.";
  }

  if (registrationStrategy === "cimd") {
    return "Automatic discovery resolved to Client ID Metadata Documents (CIMD).";
  }

  if (registrationStrategy === "dcr") {
    return "Automatic discovery resolved to Dynamic Client Registration (DCR).";
  }

  if (warnings.length > 0) {
    return warnings[0];
  }

  if (capabilities.registrationStrategies.length > 0) {
    return `Supported strategies: ${capabilities.registrationStrategies.join(", ")}.`;
  }

  return "OAuth authorization is ready.";
}

export function resolveRegistrationStrategies(
  protocolVersion: OAuthProtocolVersion,
  authServerMetadata: Record<string, unknown> | undefined,
): Array<"preregistered" | "dcr" | "cimd"> {
  const strategies: Array<"preregistered" | "dcr" | "cimd"> = [
    "preregistered",
  ];

  if (authServerMetadata?.registration_endpoint) {
    strategies.push("dcr");
  }

  if (
    protocolVersion === "2025-11-25" &&
    authServerMetadata?.client_id_metadata_document_supported === true
  ) {
    strategies.push("cimd");
  }

  return strategies;
}

function buildCapabilities(
  protocolVersion: OAuthProtocolVersion,
  discovery?: AuthorizationDiscoverySnapshot,
): AuthorizationPlanCapabilities {
  const registrationStrategies =
    discovery?.registrationStrategies ??
    resolveRegistrationStrategies(
      protocolVersion,
      discovery?.authorizationServerMetadata,
    );

  return {
    registrationStrategies,
    supportsCimd: registrationStrategies.includes("cimd"),
    supportsDcr: registrationStrategies.includes("dcr"),
    authorizationServerMetadataUrl: discovery?.authorizationServerMetadataUrl,
    resourceMetadataUrl: discovery?.resourceMetadataUrl,
    discoveryError: discovery?.discoveryError,
  };
}

export function resolveAuthorizationPlan(
  input: AuthorizationPlanInput,
): ResolvedAuthorizationPlan {
  const protocolMode = normalizeProtocolMode(input);
  const protocolVersion = resolveProtocolVersion(input);
  const registrationMode = normalizeRegistrationMode(input);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const capabilities = buildCapabilities(protocolVersion, input.discovery);
  const hasDiscovery = input.discovery !== undefined;
  const trimmedClientId = input.clientId?.trim();
  const trimmedClientSecret = input.clientSecret?.trim();
  const hasPreregisteredCredentials = Boolean(
    input.useRegistryOAuthProxy || trimmedClientId || trimmedClientSecret,
  );
  const clientIdMetadataUrl =
    normalizeClientIdMetadataUrl(input.clientIdMetadataUrl) ??
    DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL;
  const authMode = input.authMode ?? "interactive";

  let status: ResolvedAuthorizationPlan["status"] = "ready";
  let registrationStrategy: OAuthRegistrationStrategy | undefined;

  if (capabilities.discoveryError) {
    warnings.push(capabilities.discoveryError);
  }

  if (registrationMode === "preregistered") {
    registrationStrategy = "preregistered";
    if (!input.useRegistryOAuthProxy && !trimmedClientId) {
      blockers.push(
        "Pre-registered OAuth requires a client ID before the flow can start.",
      );
    }
    if (authMode === "client_credentials" && !trimmedClientSecret) {
      blockers.push(
        "Client credentials mode requires a client secret for pre-registered OAuth.",
      );
    }
  } else if (registrationMode === "cimd") {
    registrationStrategy = "cimd";
    if (protocolVersion !== "2025-11-25") {
      blockers.push(
        `CIMD registration is not supported for protocol version ${protocolVersion}.`,
      );
    }
    if (authMode === "client_credentials") {
      blockers.push(
        "Client credentials mode cannot use Client ID Metadata Documents (CIMD).",
      );
    }
    if (hasDiscovery && !capabilities.supportsCimd) {
      blockers.push(
        "The authorization server did not advertise Client ID Metadata Document support.",
      );
    }
  } else if (registrationMode === "dcr") {
    registrationStrategy = "dcr";
    if (hasDiscovery && !capabilities.supportsDcr) {
      blockers.push(
        "The authorization server did not advertise a registration_endpoint required for DCR.",
      );
    }
  } else if (hasPreregisteredCredentials) {
    registrationStrategy = "preregistered";
  } else if (!hasDiscovery) {
    status = "discovery_required";
  } else if (authMode !== "client_credentials" && capabilities.supportsCimd) {
    registrationStrategy = "cimd";
  } else if (capabilities.supportsDcr) {
    registrationStrategy = "dcr";
  } else {
    blockers.push(
      authMode === "client_credentials"
        ? "Automatic OAuth could not find a client_credentials-compatible flow. Configure pre-registered credentials or use a server that supports DCR."
        : "Automatic OAuth could not find a usable CIMD or DCR flow. Configure pre-registered credentials to continue.",
    );
  }

  if (blockers.length > 0) {
    status = "blocked";
  }

  const plan: ResolvedAuthorizationPlan = {
    protocolMode,
    protocolVersion,
    registrationMode,
    ...(registrationStrategy ? { registrationStrategy } : {}),
    status,
    blockers,
    warnings,
    capabilities,
    ...(input.serverUrl
      ? { canonicalResource: canonicalizeResourceUrl(input.serverUrl) }
      : {}),
    ...((registrationStrategy === "cimd" ||
      registrationMode === "cimd") && clientIdMetadataUrl
      ? { clientIdMetadataUrl }
      : {}),
    summary: "",
  };

  plan.summary = summarizePlan(
    plan.status,
    plan.registrationStrategy,
    blockers,
    warnings,
    capabilities,
  );

  return plan;
}
