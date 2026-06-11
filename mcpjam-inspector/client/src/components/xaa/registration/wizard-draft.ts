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

/** Map the draft to the upsert input; own-AS fields and the secret are only
 * sent when meaningful. */
export function draftToInput(
  draft: RegistrationDraft,
  editingId?: string,
): XaaResourceAppInput {
  const own = draft.authServerMode === "own";
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
  };
}
