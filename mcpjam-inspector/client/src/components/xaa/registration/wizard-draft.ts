import type { HttpServerConfig } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/hooks/use-app-state";
import type {
  XaaAuthServerMode,
  XaaResourceApp,
  XaaResourceAppInput,
  XaaResourceType,
} from "@/lib/xaa/types";

export interface RegistrationDraft {
  name: string;
  resourceType: XaaResourceType;
  resourceUrl: string;
  authServerMode: XaaAuthServerMode;
  tokenEndpoint: string;
  issuer: string;
  targetClientId: string;
  /** Never pre-filled from the server; blank on edit means "keep stored". */
  secret: string;
  /** Space-separated in the form; split into an array on save. */
  scopes: string;
  healthCheckUrl: string;
}

export const EMPTY_DRAFT: RegistrationDraft = {
  name: "",
  resourceType: "mcp",
  resourceUrl: "",
  authServerMode: "own",
  tokenEndpoint: "",
  issuer: "",
  targetClientId: "",
  secret: "",
  scopes: "",
  healthCheckUrl: "",
};

export function draftFromResourceApp(app: XaaResourceApp): RegistrationDraft {
  return {
    name: app.name,
    resourceType: app.resourceType,
    resourceUrl: app.resourceUrl,
    authServerMode: app.authServerMode,
    tokenEndpoint: app.tokenEndpoint ?? "",
    issuer: app.issuer ?? "",
    targetClientId: app.targetClientId ?? "",
    secret: "",
    scopes: (app.scopes ?? []).join(" "),
    healthCheckUrl: app.healthCheckUrl ?? "",
  };
}

/** Only HTTP(S) servers can seed a registration — STDIO servers have no
 * resource URL for the ID-JAG's `resource` claim to point at. */
export function isPickableServer(server: ServerWithName): boolean {
  return "url" in server.config;
}

/**
 * The draft fields the "start from an existing server" picker derives — an
 * admin-owned SNAPSHOT of the server row at pick time, never a live
 * reference. A pick overwrites exactly these fields (a deliberate pick is an
 * explicit action, and applying only the populated ones would silently mix
 * two servers' details); everything the picker has no data for — secret,
 * token endpoint, auth-server mode, health-check settings — is untouched.
 */
export function draftFromServer(
  server: ServerWithName,
): Pick<
  RegistrationDraft,
  "name" | "resourceType" | "resourceUrl" | "issuer" | "targetClientId" | "scopes"
> {
  const httpConfig =
    "url" in server.config ? (server.config as HttpServerConfig) : null;
  const clientId = (httpConfig as any)?.clientId;
  const oauthScopes = (httpConfig as any)?.oauthScopes;
  return {
    name: server.name,
    resourceType: "mcp",
    resourceUrl: httpConfig?.url ? String(httpConfig.url) : "",
    issuer: server.xaaAuthzIssuer ?? "",
    targetClientId: typeof clientId === "string" ? clientId : "",
    scopes: Array.isArray(oauthScopes)
      ? oauthScopes.filter((s): s is string => typeof s === "string").join(" ")
      : "",
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateBasicInfo(draft: RegistrationDraft): string | null {
  if (!draft.name.trim()) {
    return "Name is required.";
  }
  if (!draft.resourceUrl.trim()) {
    return "Resource URL is required.";
  }
  if (!isHttpUrl(draft.resourceUrl.trim())) {
    return "Resource URL must be a valid http(s) URL.";
  }
  return null;
}

export function validateAuthServer(draft: RegistrationDraft): string | null {
  if (draft.authServerMode === "mcpjam") {
    return null;
  }
  if (!draft.tokenEndpoint.trim()) {
    return "Token endpoint is required when using your own auth server.";
  }
  if (!isHttpUrl(draft.tokenEndpoint.trim())) {
    return "Token endpoint must be a valid http(s) URL.";
  }
  return null;
}

export function validateScopesConfig(draft: RegistrationDraft): string | null {
  if (draft.healthCheckUrl.trim() && !isHttpUrl(draft.healthCheckUrl.trim())) {
    return "Health check URL must be a valid http(s) URL.";
  }
  return null;
}

export function parseScopes(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/** Map the draft to the upsert input; own-AS fields and the secret are only
 * sent when meaningful. */
export function draftToInput(
  draft: RegistrationDraft,
  editingId?: string,
): XaaResourceAppInput {
  const own = draft.authServerMode === "own";
  const scopes = parseScopes(draft.scopes);
  return {
    ...(editingId ? { id: editingId } : {}),
    name: draft.name.trim(),
    resourceType: draft.resourceType,
    resourceUrl: draft.resourceUrl.trim(),
    authServerMode: draft.authServerMode,
    ...(own && draft.tokenEndpoint.trim()
      ? { tokenEndpoint: draft.tokenEndpoint.trim() }
      : {}),
    ...(own && draft.issuer.trim() ? { issuer: draft.issuer.trim() } : {}),
    ...(own && draft.targetClientId.trim()
      ? { targetClientId: draft.targetClientId.trim() }
      : {}),
    ...(own && draft.secret ? { secret: draft.secret } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(draft.healthCheckUrl.trim()
      ? { healthCheckUrl: draft.healthCheckUrl.trim() }
      : {}),
  };
}
