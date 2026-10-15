/**
 * OpenAI's per-server auth declaration — `extensions["com.openai"].auth` on
 * an MCP server entry — read into a typed descriptor before anything generic
 * touches the entry.
 *
 * An allowlist, because both generic paths are wrong here: the secret screen
 * drops keys named like credentials (`tokenUrl`) and long opaque values,
 * mangling a public declaration, while a verbatim copy could store a
 * credential. Documented non-secret fields are validated and kept; anything
 * else is reported and dropped. A declared client ID is a hint, not evidence
 * that the client accepts MCPJam's redirect URI.
 */

import { OPENAI_EXTENSION_NAMESPACE } from "./manifest.js";
import { isLoopbackHost, isUnsafeRawUrl } from "./mcp-entry-values.js";
import type { PluginHeaderRequirement } from "./mcp-config.js";
import { SECRET_FIELD_NAME, type PluginIssueCollector } from "./validation.js";

export type PluginTokenEndpointAuthMethod =
  "none" | "client_secret_basic" | "client_secret_post" | "private_key_jwt";

export type PluginOAuthClient =
  | {
      mode: "provided";
      clientId: string;
      tokenEndpointAuthMethod?: PluginTokenEndpointAuthMethod;
    }
  | { mode: "dcr" }
  | { mode: "cimd" };

/** OAuth fields OpenAI documents; every omitted value falls back to discovery. */
export interface PluginOAuthDeclaration {
  client?: PluginOAuthClient;
  registrationUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  authorizationServerBase?: string;
  resource?: string;
  baseScopes?: string[];
  defaultScopes?: string[];
  oidcEnabled?: boolean;
  oidcConfigurationUrl?: string;
  oidcUserinfoEndpoint?: string;
  oidcScopesSupported?: string[];
}

export type PluginServerAuth =
  | { type: "none" }
  | ({ type: "oauth" | "mixed" } & PluginOAuthDeclaration)
  | { type: "api_key"; headerScheme: "bearer" | "basic" }
  | { type: "api_key"; headerScheme: "custom_header"; headerName: string };

export type PluginApiKeyAuth = Extract<PluginServerAuth, { type: "api_key" }>;

const URL_FIELDS = [
  "registrationUrl",
  "authorizationUrl",
  "tokenUrl",
  "authorizationServerBase",
  "resource",
  "oidcConfigurationUrl",
  "oidcUserinfoEndpoint",
] as const;
const SCOPE_FIELDS = [
  "baseScopes",
  "defaultScopes",
  "oidcScopesSupported",
] as const;
const TOKEN_METHODS: readonly PluginTokenEndpointAuthMethod[] = [
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
];

const oneOf = <T extends string>(
  values: readonly T[],
  value: unknown
): value is T => values.some((candidate) => candidate === value);
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

interface ReadContext {
  serverKey: string;
  componentKey: string;
  issues: PluginIssueCollector;
}

class InvalidAuth extends Error {}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Report a key the allowlist does not keep, as secret-bearing when it looks it. */
function dropField(field: string, ctx: ReadContext): void {
  const secret = SECRET_FIELD_NAME.test(field);
  ctx.issues.warn(
    secret ? "MCP_SECRET_FIELD_OMITTED" : "MCP_UNKNOWN_FIELD",
    `server "${ctx.serverKey}": auth field "${field}" ${
      secret
        ? "looks secret-bearing and is not stored"
        : "is not supported; ignored"
    }`,
    { componentKey: ctx.componentKey }
  );
}

/**
 * Absolute HTTPS (or loopback HTTP) with nothing `URL` drops or rewrites, so
 * the string kept is the one checked: a resource indicator matches bytewise.
 */
function readEndpoint(field: string, value: unknown): string {
  let url: URL | undefined;
  try {
    url = typeof value === "string" ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  const secure =
    url?.protocol === "https:" ||
    (url?.protocol === "http:" && isLoopbackHost(url.hostname));
  if (
    typeof value !== "string" ||
    url === undefined ||
    !secure ||
    isUnsafeRawUrl(value)
  ) {
    // Not echoed: an endpoint with userinfo carries a credential.
    throw new InvalidAuth(
      `auth.${field} must be an absolute HTTPS (or loopback HTTP) URL without credentials, a fragment, whitespace or backslashes`
    );
  }
  return value;
}

function readClient(raw: unknown, ctx: ReadContext): PluginOAuthClient {
  if (!isPlainRecord(raw))
    throw new InvalidAuth("auth.client must be an object");
  const { mode, clientId, tokenEndpointAuthMethod, ...rest } = raw;
  for (const field of Object.keys(rest)) dropField(field, ctx);
  if (mode === "dcr" || mode === "cimd") {
    if (clientId !== undefined) dropField("clientId", ctx);
    if (tokenEndpointAuthMethod !== undefined) {
      dropField("tokenEndpointAuthMethod", ctx);
    }
    return { mode };
  }
  if (mode !== "provided") {
    throw new InvalidAuth(
      `auth.client.mode must be "provided", "dcr" or "cimd"`
    );
  }
  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new InvalidAuth(`a "provided" client needs auth.client.clientId`);
  }
  if (tokenEndpointAuthMethod === undefined) return { mode, clientId };
  if (!oneOf(TOKEN_METHODS, tokenEndpointAuthMethod)) {
    throw new InvalidAuth(
      "auth.client.tokenEndpointAuthMethod is not supported"
    );
  }
  return { mode, clientId, tokenEndpointAuthMethod };
}

function readOAuth(
  raw: Record<string, unknown>,
  ctx: ReadContext
): PluginOAuthDeclaration {
  const declaration: PluginOAuthDeclaration = {};
  for (const [field, value] of Object.entries(raw)) {
    if (field === "type") continue;
    if (field === "client") {
      declaration.client = readClient(value, ctx);
    } else if (oneOf(URL_FIELDS, field)) {
      declaration[field] = readEndpoint(field, value);
    } else if (oneOf(SCOPE_FIELDS, field)) {
      if (!Array.isArray(value) || value.some((s) => typeof s !== "string")) {
        throw new InvalidAuth(`auth.${field} must be an array of strings`);
      }
      declaration[field] = value.map(String);
    } else if (field === "oidcEnabled") {
      if (typeof value !== "boolean") {
        throw new InvalidAuth("auth.oidcEnabled must be a boolean");
      }
      declaration.oidcEnabled = value;
    } else {
      dropField(field, ctx);
    }
  }
  return declaration;
}

function readApiKey(
  raw: Record<string, unknown>,
  ctx: ReadContext
): PluginApiKeyAuth {
  const { type: _type, headerScheme, headerName, ...rest } = raw;
  for (const field of Object.keys(rest)) dropField(field, ctx);
  if (headerScheme === "bearer" || headerScheme === "basic") {
    if (headerName !== undefined) dropField("headerName", ctx);
    return { type: "api_key", headerScheme };
  }
  if (headerScheme !== "custom_header") {
    throw new InvalidAuth(
      `auth.headerScheme must be "bearer", "basic" or "custom_header"`
    );
  }
  if (
    typeof headerName !== "string" ||
    !HTTP_TOKEN.test(headerName) ||
    headerName.toLowerCase() === "host"
  ) {
    throw new InvalidAuth(
      "a custom_header API key needs a valid auth.headerName other than Host"
    );
  }
  return { type: "api_key", headerScheme, headerName };
}

/**
 * The typed auth an entry's `extensions` declare: `{}` when none, `{ auth }`
 * when valid, `{ error }` (which invalidates the entry) when invalid.
 */
export function readOpenAiServerAuth(
  extensions: unknown,
  ctx: ReadContext
): { auth?: PluginServerAuth; error?: string } {
  const openai = isPlainRecord(extensions)
    ? extensions[OPENAI_EXTENSION_NAMESPACE]
    : undefined;
  const raw = isPlainRecord(openai) ? openai.auth : undefined;
  if (raw === undefined) return {};
  try {
    if (!isPlainRecord(raw)) throw new InvalidAuth("auth must be an object");
    switch (raw.type) {
      case "none":
        for (const field of Object.keys(raw)) {
          if (field !== "type") dropField(field, ctx);
        }
        return { auth: { type: "none" } };
      case "oauth":
      case "mixed":
        return { auth: { type: raw.type, ...readOAuth(raw, ctx) } };
      case "api_key":
        return { auth: readApiKey(raw, ctx) };
      default:
        throw new InvalidAuth(
          `auth.type must be "none", "oauth", "mixed" or "api_key"`
        );
    }
  } catch (error) {
    if (!(error instanceof InvalidAuth)) throw error;
    return { error: error.message };
  }
}

/** The header an `api_key` credential travels in. */
export function pluginApiKeyHeaderName(auth: PluginApiKeyAuth): string {
  return auth.headerScheme === "custom_header"
    ? auth.headerName
    : "Authorization";
}

/**
 * Header requirements with the API key's header marked secret and carrying
 * its scheme. A same-named declared header (in any casing) is that header.
 */
export function withApiKeyHeader(
  requirements: PluginHeaderRequirement[],
  auth: PluginApiKeyAuth
): PluginHeaderRequirement[] {
  const name = pluginApiKeyHeaderName(auth);
  const others = requirements.filter(
    (requirement) => requirement.name.toLowerCase() !== name.toLowerCase()
  );
  return [...others, { name, secret: true, scheme: auth.headerScheme }].sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

/**
 * The header to send for a user-supplied API key, or null when the credential
 * holds no token or a character no header can carry (NUL, CR, LF). Bearer and
 * Basic values gain their scheme once: a pasted "Bearer abc" stays
 * "Bearer abc". A Basic credential is taken as the already-encoded token; a
 * custom header gets the value as given.
 */
export function renderPluginApiKeyHeader(
  auth: PluginApiKeyAuth,
  credential: string
): { name: string; value: string } | null {
  const value = credential.trim();
  if (/[\0\r\n]/.test(value)) return null;
  if (auth.headerScheme === "custom_header") {
    return value ? { name: auth.headerName, value } : null;
  }
  const bearer = auth.headerScheme === "bearer";
  const token = value.replace(
    bearer ? /^bearer(?:\s+|$)/i : /^basic(?:\s+|$)/i,
    ""
  );
  if (!token) return null;
  return {
    name: "Authorization",
    value: `${bearer ? "Bearer" : "Basic"} ${token}`,
  };
}
