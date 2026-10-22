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
import { resolveContainedPath } from "./paths.js";
import {
  isSecretLikeValue,
  SECRET_FIELD_NAME,
  sanitizeUnknownRecord,
  type PluginIssueCode,
  type PluginIssueCollector,
} from "./validation.js";

/** Loopback hosts, where plain HTTP is tolerated for local development. */
export function isLoopbackHost(hostname: string): boolean {
  return (
    ["localhost", "[::1]", "::1"].includes(hostname) ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

/**
 * Userinfo, a fragment (even `https:@h/#`) or anything `URL` would rewrite,
 * including a host that does not follow exactly two slashes (`https:h`,
 * `https:/h`, `https:///h` all read as `https://h`). A link shown to members
 * may keep its fragment.
 */
export const isUnsafeRawUrl = (
  raw: string,
  options?: { allowFragment?: boolean }
): boolean =>
  !/^[^:/?#]+:\/\/[^\\/?#]/.test(raw) ||
  /^[^:]*:[\\/]*[^\\/?#]*@|[\\\s]/.test(raw) ||
  (options?.allowFragment !== true && raw.includes("#")) ||
  [...raw].some((char) => char < " " || char === "\u007f");

/**
 * Two or more words joined by `-` or `_`, as in a docs slug
 * (`getting-started-with-the-mcpjam-plugin`). The secret screen reads any long
 * run of these characters as a token. One unbroken run of letters is not a
 * slug, since a key can be written in letters only.
 */
const WORD_SLUG = /^[a-z]+(?:[-_][a-z]+)+$/i;

/**
 * A part's ASCII percent escapes decoded, except `%2F`, which would join a
 * path's segments into one run. Any other `%` stays as written.
 */
const decodeAsciiEscapes = (part: string): string =>
  part.replace(/%(?!2f)([0-7][0-9a-f])/gi, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );

/**
 * `URL` keeps the percent escapes of a path and a fragment (`sk%2Dlive…`), so
 * a part is read decoded too.
 */
function urlPartLooksSecret(part: string): boolean {
  return [part, decodeAsciiEscapes(part)].some(
    (form) => isSecretLikeValue(form) && !WORD_SLUG.test(form)
  );
}

/**
 * A path segment, query value or fragment that looks like a credential, or a
 * query or fragment parameter named like one: a personal MCP URL often
 * carries its key in the path, `?api_key=…` in the query, and an OAuth
 * redirect `#access_token=…` in the fragment. Each part is tested on its own,
 * since a long path read whole would look like a token run.
 */
export function urlCarriesSecret(url: URL): boolean {
  if (url.pathname.split("/").some(urlPartLooksSecret)) return true;
  const fragment = url.hash.slice(1);
  if (urlPartLooksSecret(fragment)) return true;
  for (const params of [url.searchParams, new URLSearchParams(fragment)]) {
    for (const [name, value] of params) {
      if (urlPartLooksSecret(value)) return true;
      if (value !== "" && SECRET_FIELD_NAME.test(name)) return true;
    }
  }
  return false;
}

type ValueCheck<T> =
  | ({ ok: true } & T)
  | { ok: false; code: PluginIssueCode; message: string };

/**
 * A remote server URL: absolute, HTTPS unless loopback, with exactly two
 * slashes before the host and nothing `URL` drops or rewrites (userinfo, a
 * fragment, whitespace, a backslash), so the string stored is the one checked.
 * A URL carrying a credential, as user info or in a path segment or query, is
 * refused rather than stored, and no message repeats it.
 */
export function checkServerUrl(
  url: string
): ValueCheck<{ loopbackHttp: boolean }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      code: "MCP_INVALID_SERVER",
      message: `"url" is not a valid URL`,
    };
  }
  if (isUnsafeRawUrl(url)) {
    return {
      ok: false,
      code: "MCP_INVALID_SERVER",
      message: `"url" must be an absolute https:// URL (or a loopback http:// one) without credentials, a fragment, whitespace or backslashes`,
    };
  }
  if (urlCarriesSecret(parsed)) {
    return {
      ok: false,
      code: "MCP_INVALID_SERVER",
      message: `"url" looks like it carries a credential, which a plugin must not ship`,
    };
  }
  if (parsed.protocol === "https:") return { ok: true, loopbackHttp: false };
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
    return { ok: true, loopbackHttp: true };
  }
  return {
    ok: false,
    code: "MCP_INSECURE_URL",
    message: "remote MCP servers must use HTTPS",
  };
}

/**
 * A working directory in its canonical placeholder form, contained in the
 * plugin root or data directory: `./x` becomes `${PLUGIN_ROOT}/x`, and a
 * placeholder-rooted path is normalized under its placeholder, so a `..`
 * that would leave either directory is refused.
 */
export function resolveWorkingDirectory(cwd: unknown): ValueCheck<{
  value: string;
}> {
  if (typeof cwd !== "string") {
    return {
      ok: false,
      code: "MCP_INVALID_SERVER",
      message: `"cwd" must be a string`,
    };
  }
  const match = /^(\.|\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\})(?:\/(.*))?$/s.exec(
    cwd
  );
  if (match === null || (match[1] === "." && match[2] === undefined)) {
    return {
      ok: false,
      code: "MCP_INVALID_WORKING_DIRECTORY",
      message: `"cwd" must start with "./", "\${PLUGIN_ROOT}", or "\${PLUGIN_DATA}"`,
    };
  }
  const root = match[1] === "." ? "${PLUGIN_ROOT}" : match[1];
  const rest = match[2] ?? "";
  if (rest.replace(/[/.]/g, "") === "" && !rest.includes("..")) {
    return { ok: true, value: root };
  }
  const resolved = resolveContainedPath("", rest);
  return resolved.ok
    ? { ok: true, value: `${root}/${resolved.path}` }
    : { ok: false, code: resolved.code, message: resolved.message };
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
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(
    headers as Record<string, unknown>
  )) {
    // Header names are case-insensitive: two casings of one name would leave
    // the value actually sent up to whichever the HTTP stack keeps.
    if (seen.has(name.toLowerCase())) {
      issues.error(
        "MCP_INVALID_HEADERS",
        `server "${serverKey}": header "${name}" is declared more than once`,
        { componentKey }
      );
      return null;
    }
    seen.add(name.toLowerCase());
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
