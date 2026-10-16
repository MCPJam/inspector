/**
 * Normalization of one MCP server entry's values: `env`, `headers`, and the
 * MCPJam `oauth`/`authentication` hints. Every rule that decides whether a
 * declared value is stored, kept as a runtime template, or turned into a
 * name-only setup requirement lives here.
 */

import type {
  NormalizedPluginOAuthHint,
  PluginEnvRequirement,
  PluginHeaderRequirement,
} from "./mcp-config.js";
import {
  isSecretLikeValue,
  SECRET_FIELD_NAME,
  sanitizeUnknownRecord,
  type PluginIssueCollector,
} from "./validation.js";

/** Loopback hosts, where plain HTTP is tolerated for local development. */
export function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}

/**
 * Userinfo, a fragment (even `https:@h/#`) or anything `URL` would rewrite,
 * including a host that does not follow exactly two slashes (`https:h`,
 * `https:/h`, `https:///h` all read as `https://h`).
 */
export const isUnsafeRawUrl = (raw: string): boolean =>
  !/^[^:/?#]+:\/\/[^\\/?#]/.test(raw) ||
  /^[^:]*:[\\/]*[^\\/?#]*@|[#\\\s]/.test(raw) ||
  [...raw].some((char) => char < " " || char === "\u007f");

/**
 * A path segment or query value that looks like a credential, or a query
 * parameter named like one: a personal MCP URL often carries its key in the
 * path, and `?api_key=…` in the query. Each part is tested on its own, since a
 * long path read whole would look like a token run.
 */
export function urlCarriesSecret(url: URL): boolean {
  if (url.pathname.split("/").some((segment) => isSecretLikeValue(segment))) {
    return true;
  }
  for (const [name, value] of url.searchParams) {
    if (isSecretLikeValue(value)) return true;
    if (value !== "" && SECRET_FIELD_NAME.test(name)) return true;
  }
  return false;
}

/** `${SOME_VAR}`-style reference that must be resolved by the user at setup. */
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** Every `${VAR}` reference inside a composite value. */
const ENV_REFERENCE_GLOBAL = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * A PURE placeholder path template: the placeholder itself, optionally
 * followed by a path-y remainder. Anything else — including a secret with a
 * placeholder smuggled onto the end ("sk-live-...${PLUGIN_ROOT}") — takes
 * the normal literal-value path.
 */
const PURE_PLACEHOLDER_TEMPLATE =
  /^\$\{(?:PLUGIN_ROOT|PLUGIN_DATA)\}[A-Za-z0-9._/-]*$/;

const RESERVED_ENV_KEYS = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);

/**
 * Characters allowed in the non-reference remainder of a composite template
 * ("postgres://${DB_HOST}:${DB_PORT}/x"). A remainder outside this set, or
 * one containing a long opaque token run, looks like an embedded credential:
 * the template is then dropped instead of stored.
 */
const TEMPLATE_SAFE_REMAINDER = /^[A-Za-z0-9.:/@,+_-]*$/;
const LONG_TOKEN_RUN = /[A-Za-z0-9_-]{16,}/;

/** Header names that carry credentials (drives `secret: true`). */
const SECRET_HEADER_NAME =
  /(authorization|token|secret|api[-_]?key|cookie|password|credential)/i;

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function normalizeEnv(
  serverKey: string,
  componentKey: string,
  env: unknown,
  issues: PluginIssueCollector
): PluginEnvRequirement[] | null {
  if (env === undefined) return [];
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    issues.error(
      "MCP_INVALID_ENV",
      `server "${serverKey}": "env" must be an object`,
      { componentKey }
    );
    return null;
  }
  const byNameMap = new Map<string, PluginEnvRequirement>();
  const referencedVars = new Set<string>();
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    if (RESERVED_ENV_KEYS.has(name)) {
      // Spec: env may not define the client-controlled placeholder keys.
      issues.error(
        "MCP_RESERVED_ENV_KEY",
        `server "${serverKey}": env may not define "${name}" — it is client-controlled`,
        { componentKey }
      );
      return null;
    }
    if (typeof value !== "string") {
      issues.error(
        "MCP_INVALID_ENV",
        `server "${serverKey}": env "${name}" must be a string`,
        { componentKey }
      );
      continue;
    }
    if (PURE_PLACEHOLDER_TEMPLATE.test(value)) {
      // Pure path template resolved by the runtime at launch — not a secret.
      byNameMap.set(name, { name, required: false, valueTemplate: value });
      continue;
    }
    if (value === "" || ENV_REFERENCE.test(value)) {
      byNameMap.set(name, { name, required: true });
      continue;
    }
    const refs = [...value.matchAll(ENV_REFERENCE_GLOBAL)]
      .map((match) => match[1])
      .filter((variable) => !RESERVED_ENV_KEYS.has(variable));
    if (refs.length > 0) {
      // Composite template ("postgres://${DB_HOST}:${DB_PORT}/x"): store it
      // with placeholders preserved only when the literal remainder cannot
      // plausibly be a credential; always register the referenced variables
      // as required setup.
      const remainder = value.replace(ENV_REFERENCE_GLOBAL, "");
      const safeRemainder =
        TEMPLATE_SAFE_REMAINDER.test(remainder) &&
        !LONG_TOKEN_RUN.test(remainder) &&
        !SECRET_FIELD_NAME.test(name);
      if (safeRemainder) {
        byNameMap.set(name, { name, required: false, valueTemplate: value });
        for (const variable of refs) referencedVars.add(variable);
        continue;
      }
    } else if (!SECRET_FIELD_NAME.test(name) && !isSecretLikeValue(value)) {
      // Plain literal that passed the secret screen: store it, so portable
      // plugins declaring non-secret config ({"MODE": "production"}) run
      // without a setup step.
      byNameMap.set(name, { name, required: false, value });
      continue;
    }
    // A secret-looking literal (or a composite whose remainder failed the
    // screen). Never persist it — it may be a credential. The bundle DID
    // declare a value here, so the component cannot run until the user
    // re-supplies one: the requirement is required, not optional.
    byNameMap.set(name, { name, required: true });
    issues.warn(
      "MCP_ENV_VALUE_OMITTED",
      `server "${serverKey}": literal value of env "${name}" is not stored; configure it during setup`,
      { componentKey }
    );
  }
  for (const variable of referencedVars) {
    if (!byNameMap.has(variable)) {
      byNameMap.set(variable, { name: variable, required: true });
    }
  }
  // Sorted so the configHash is insensitive to source key order.
  return [...byNameMap.values()].sort(byName);
}

export function normalizeHeaders(
  serverKey: string,
  componentKey: string,
  headers: unknown,
  issues: PluginIssueCollector
): PluginHeaderRequirement[] | null {
  if (headers === undefined) return [];
  if (
    headers === null ||
    typeof headers !== "object" ||
    Array.isArray(headers)
  ) {
    issues.error(
      "MCP_INVALID_HEADERS",
      `server "${serverKey}": "headers" must be an object`,
      { componentKey }
    );
    return null;
  }
  const requirements: PluginHeaderRequirement[] = [];
  for (const [name, value] of Object.entries(
    headers as Record<string, unknown>
  )) {
    if (typeof value !== "string") {
      issues.error(
        "MCP_INVALID_HEADERS",
        `server "${serverKey}": header "${name}" must be a string`,
        { componentKey }
      );
      continue;
    }
    const secretName = SECRET_HEADER_NAME.test(name);
    if (value === "" || ENV_REFERENCE.test(value)) {
      requirements.push({ name, secret: secretName });
      continue;
    }
    const secretValue = isSecretLikeValue(value);
    if (!secretName && !secretValue) {
      // Screened non-secret literal ("X-Api-Version: 2") — store it.
      requirements.push({ name, secret: false, value });
      continue;
    }
    issues.warn(
      "MCP_HEADER_VALUE_OMITTED",
      `server "${serverKey}": literal value of header "${name}" is not stored; configure it during setup`,
      { componentKey }
    );
    // A value that LOOKED secret marks the header secret even under an
    // innocuous name, so setup UIs mask what the user re-enters.
    requirements.push({ name, secret: secretName || secretValue });
  }
  // Sorted so the configHash is insensitive to source key order.
  return requirements.sort(byName);
}

export function normalizeOAuthHint(
  serverKey: string,
  componentKey: string,
  raw: Record<string, unknown>,
  issues: PluginIssueCollector
): NormalizedPluginOAuthHint {
  const hint: NormalizedPluginOAuthHint = {};

  const authentication = raw.authentication;
  if (typeof authentication === "string") {
    const timing = authentication.toLowerCase();
    if (timing === "on_install") hint.timing = "on_install";
    else if (timing === "on_use") hint.timing = "on_use";
  }

  const oauth =
    raw.oauth ??
    (typeof authentication === "object" ? authentication : undefined);
  if (oauth && typeof oauth === "object" && !Array.isArray(oauth)) {
    const oauthRecord = oauth as Record<string, unknown>;
    const scopes = oauthRecord.scopes;
    if (
      Array.isArray(scopes) &&
      scopes.every((scope) => typeof scope === "string")
    ) {
      hint.scopes = scopes as string[];
    }
    const candidates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(oauthRecord)) {
      if (key === "scopes") continue;
      candidates[key] = value;
    }
    // Recursive sanitation: this metadata lands in the hashed config DTO, so
    // no secret-looking key OR value at any depth may survive.
    const metadata = sanitizeUnknownRecord(candidates, {
      issues,
      secretCode: "MCP_SECRET_FIELD_OMITTED",
      label: `server "${serverKey}": oauth`,
      context: { componentKey },
    });
    if (Object.keys(metadata).length > 0) hint.metadata = metadata;
  }

  return hint;
}
