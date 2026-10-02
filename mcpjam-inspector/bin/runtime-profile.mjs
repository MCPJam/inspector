/**
 * ONE resolved runtime configuration per Inspector instance.
 *
 * The launcher resolves it once — which backend, which WorkOS client, which
 * guest authority, which ports and origins — and hands the result to the
 * server, Vite and the platform MCP worker explicitly. None of them then reads
 * configuration files of its own (`MCPJAM_RESOLVED_RUNTIME=1`), so no child can
 * quietly fill a value the selected profile left out from some other file.
 *
 * Plain ESM with no dependencies: it runs under a bare Node before anything is
 * built (`bin/start.js`, `scripts/*.mjs`, the Vite config).
 *
 * PROFILES. A target is resolved from layers, lowest priority first:
 *
 *   local (default)  the committed standard OSS profile (`.env.local`), then a
 *                    developer overlay: this worktree's `.env.development.local`,
 *                    or — only because no target was selected — the main
 *                    worktree's, read in place and never copied.
 *   --env-file F     F alone. Explicit selection wins over everything.
 *   staging          public staging defaults, the MCPJAM_STAGING_* URLs, then
 *                    this worktree's `.env.staging.local`.
 *   preview A B      public staging WorkOS defaults, the two URLs, then
 *                    `--env-file` if given.
 *
 * Settings that belong together are resolved as a GROUP: the backend group
 * (Convex addresses, guest authority, every backend-bound credential) and the
 * auth group (WorkOS ids/credentials, CLI/Slack/Discord auth) each come
 * entirely from the highest layer that sets any of their keys. A developer
 * overlay that points at another deployment therefore cannot inherit the
 * standard profile's credentials, and an explicit target never inherits the
 * standard profile at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const RESOLVED_RUNTIME_MARKER = "MCPJAM_RESOLVED_RUNTIME";

/** Public, non-secret identifiers. Client ids are not credentials. */
export const STAGING_WORKOS_CLIENT_ID = "client_01K4C1TVA6CMQ3G32F1P301A9G";
export const STAGING_HOSTED_ORIGIN = "https://staging.mcpjam.com";
const KNOWN_AUTHKIT_DOMAINS = {
  client_01K4C1TVPBE7JTBFQJF9SDW9P9: "login.mcpjam.com",
  client_01K4C1TVA6CMQ3G32F1P301A9G: "dynamic-echo-14-staging.authkit.app",
  client_01KTN2EWHHJCKRB8RSR307X4SG: "deep-vanilla-68-test.authkit.app",
};

const BACKEND_KEYS = new Set([
  "CONVEX_URL",
  "VITE_CONVEX_URL",
  "CONVEX_HTTP_URL",
  "VITE_CONVEX_SITE_URL",
  "CONVEX_DEPLOYMENT",
  "MCPJAM_GUEST_AUTHORITY",
  "MCPJAM_GUEST_AUTHORITY_ORIGIN",
  "MCPJAM_GUEST_SESSION_URL",
  "MCPJAM_GUEST_SESSION_REVOKE_URL",
  "MCPJAM_GUEST_PROMOTION_PROOF_URL",
  "MCPJAM_GUEST_JWKS_URL",
  "MCPJAM_GUEST_SESSION_SHARED_SECRET",
  "GUEST_SESSION_HASH_PEPPER",
  "INSPECTOR_SERVICE_TOKEN",
]);
const BACKEND_PREFIXES = ["DEPLOYMENT_SESSION_JWT_", "COMPUTERS_"];

const AUTH_KEYS = new Set([
  "WORKOS_CLIENT_ID",
  "VITE_WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
  "WORKOS_API_HOSTNAME",
  "VITE_WORKOS_API_HOSTNAME",
  "WORKOS_ISSUER",
  "AUTHKIT_DOMAIN",
  "VITE_WORKOS_REDIRECT_URI",
]);
const AUTH_PREFIXES = ["CLI_AUTH_", "SLACK_", "DISCORD_"];

/**
 * Per-instance addresses. Always computed from this instance's ports (or kept
 * only when they deliberately name a non-loopback public origin) — a value
 * inherited from the main instance must never survive a port change.
 */
export const INSTANCE_KEYS = [
  "MCPJAM_BROWSER_PORT",
  "CLIENT_PORT",
  "SERVER_PORT",
  "PORT",
  "VITE_API_BASE_URL",
  "BASE_URL",
  "WEB_ALLOWED_ORIGINS",
  "CLI_AUTH_PUBLIC_ORIGIN",
  "SLACK_LINK_PUBLIC_ORIGIN",
  "DISCORD_LINK_PUBLIC_ORIGIN",
  "MCPJAM_PLATFORM_MCP_URL",
  "MCPJAM_INSPECTOR_FRONTEND_URL",
];

/** Names that may carry a secret; their values never appear in output. */
const SECRET_NAME = /(SECRET|TOKEN|KEY|PEPPER|PASSWORD|PRIVATE)/i;

export function profileGroupOf(name) {
  if (
    BACKEND_KEYS.has(name) ||
    BACKEND_PREFIXES.some((p) => name.startsWith(p))
  ) {
    return "backend";
  }
  if (
    AUTH_KEYS.has(name) ||
    (AUTH_PREFIXES.some((p) => name.startsWith(p)) &&
      !INSTANCE_KEYS.includes(name))
  ) {
    return "auth";
  }
  return null;
}

/** Every key a profile owns: grouped settings plus per-instance addresses. */
export function isProfileOwnedKey(name) {
  return profileGroupOf(name) !== null || INSTANCE_KEYS.includes(name);
}

export class RuntimeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

// ── .env files ──────────────────────────────────────────────────────────────

/** Index of the first closing `quote` in `text`; `\` escapes in `"` only. */
function closingQuoteIndex(text, quote) {
  for (let j = 0; j < text.length; j += 1) {
    if (quote === '"' && text[j] === "\\") {
      j += 1;
      continue;
    }
    if (text[j] === quote) return j;
  }
  return -1;
}

/** Reverse `formatEnvAssignment`: `\n`, `\r`, `\"`, `\\`; others stay as-is. */
function decodeDoubleQuoted(text) {
  return text.replace(/\\([nr"\\])/g, (_, c) =>
    c === "n" ? "\n" : c === "r" ? "\r" : c,
  );
}

/**
 * Parse a dotenv file: `KEY=value`, `export KEY=value`, `#` comments, single /
 * double quotes, and double-quoted `\n` / `\"` / `\\` escapes (multi-line PEMs).
 */
export function parseEnvText(text) {
  const out = {};
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue;
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      // A quoted value may span lines until its first unescaped closing
      // quote; anything after it (e.g. `# comment`) is ignored.
      let body = value.slice(1);
      let end = closingQuoteIndex(body, quote);
      while (end === -1 && i + 1 < lines.length) {
        i += 1;
        body += `\n${lines[i]}`;
        end = closingQuoteIndex(body, quote);
      }
      value = end === -1 ? body : body.slice(0, end);
      if (quote === '"') value = decodeDoubleQuoted(value);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[key] = value;
  }
  return out;
}

/** Serialize one assignment, quoting whenever the value needs it. */
export function formatEnvAssignment(name, value) {
  const needsQuotes = /[\s#"'\\]/.test(value);
  if (!needsQuotes) return `${name}=${value}`;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/"/g, '\\"');
  return `${name}="${escaped}"`;
}

export function readEnvFile(path, fs = { existsSync, readFileSync }) {
  if (!fs.existsSync(path)) return null;
  return parseEnvText(fs.readFileSync(path, "utf8"));
}

// ── profiles ────────────────────────────────────────────────────────────────

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function convexSlug(url) {
  try {
    const host = new URL(url).hostname;
    if (!host.endsWith(".convex.cloud") && !host.endsWith(".convex.site")) {
      return null;
    }
    return host.split(".")[0] || null;
  } catch {
    return null;
  }
}

/**
 * Merge layers (lowest priority first). Grouped keys come, per group, from the
 * highest layer that sets ANY key of the group; ungrouped keys merge per key.
 */
export function mergeProfileLayers(layers) {
  const values = {};
  const sources = {};
  const groupSource = {};
  for (const group of ["backend", "auth"]) {
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const layer = layers[i];
      if (Object.keys(layer.values).some((k) => profileGroupOf(k) === group)) {
        groupSource[group] = layer.name;
        for (const [key, value] of Object.entries(layer.values)) {
          if (profileGroupOf(key) === group) {
            values[key] = value;
            sources[key] = layer.name;
          }
        }
        break;
      }
    }
  }
  // Per-instance addresses are never taken as values (they are computed from
  // ports); a profile's setting is kept only as a hint for a deliberate
  // non-loopback public origin.
  const instanceHints = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.values)) {
      if (INSTANCE_KEYS.includes(key)) {
        instanceHints[key] = value;
        continue;
      }
      if (profileGroupOf(key) !== null) continue;
      values[key] = value;
      sources[key] = layer.name;
    }
  }
  return { values, sources, groupSource, instanceHints };
}

/**
 * The profile layers for a target. Pure apart from reading the named files
 * through `fs`.
 *
 * @param {object} args
 * @param {"local"|"staging"|"preview"} [args.target]
 * @param {string} [args.envFile]       explicit profile file
 * @param {string[]} [args.previewUrls] [viteConvexUrl, convexHttpUrl]
 * @param {string} args.inspectorDir    this worktree's mcpjam-inspector dir
 * @param {string|null} [args.mainInspectorDir] the main worktree's, if different
 * @param {Record<string,string|undefined>} [args.env] launcher environment
 */
export function resolveProfileLayers(args) {
  const fs = args.fs ?? { existsSync, readFileSync };
  const env = args.env ?? {};
  const target = args.target ?? "local";
  const layers = [];
  const read = (name, path) => {
    const values = readEnvFile(path, fs);
    if (values) layers.push({ name, path, values });
    return values;
  };

  if (args.envFile) {
    const path = resolve(args.envFile);
    if (target === "preview") {
      layers.push(previewLayer(args.previewUrls));
    }
    if (!read(`--env-file ${args.envFile}`, path)) {
      throw new RuntimeConfigError(
        `--env-file ${args.envFile} does not exist.`,
      );
    }
    return { target, explicit: true, layers };
  }

  if (target === "staging") {
    layers.push({
      name: "staging defaults",
      values: {
        WORKOS_CLIENT_ID: STAGING_WORKOS_CLIENT_ID,
        VITE_WORKOS_CLIENT_ID: STAGING_WORKOS_CLIENT_ID,
      },
    });
    const viteConvexUrl = nonEmpty(env.MCPJAM_STAGING_VITE_CONVEX_URL);
    const convexHttpUrl = nonEmpty(env.MCPJAM_STAGING_CONVEX_HTTP_URL);
    const stagingFile = join(args.inspectorDir, ".env.staging.local");
    const fileValues = readEnvFile(stagingFile, fs);
    if (!fileValues && (!viteConvexUrl || !convexHttpUrl)) {
      throw new RuntimeConfigError(
        "The staging target needs MCPJAM_STAGING_VITE_CONVEX_URL and " +
          "MCPJAM_STAGING_CONVEX_HTTP_URL, or a .env.staging.local profile in this worktree.",
      );
    }
    // The staging layer is ONE layer (URLs + its file), so the backend group
    // is resolved from it as a whole.
    const values = {
      MCPJAM_GUEST_AUTHORITY: "hosted",
      MCPJAM_GUEST_AUTHORITY_ORIGIN: STAGING_HOSTED_ORIGIN,
      ...(viteConvexUrl
        ? { VITE_CONVEX_URL: viteConvexUrl, CONVEX_URL: viteConvexUrl }
        : {}),
      ...(convexHttpUrl ? { CONVEX_HTTP_URL: convexHttpUrl } : {}),
      ...(fileValues ?? {}),
    };
    layers.push({
      name: "staging",
      path: fileValues ? stagingFile : undefined,
      values,
    });
    return { target, explicit: true, layers };
  }

  if (target === "preview") {
    layers.push(previewLayer(args.previewUrls));
    return { target, explicit: true, layers };
  }

  // local: the standard OSS profile, then a developer overlay.
  read("standard profile (.env.local)", join(args.inspectorDir, ".env.local"));
  const own = join(args.inspectorDir, ".env.development.local");
  if (
    !read("worktree profile (.env.development.local)", own) &&
    args.mainInspectorDir
  ) {
    const main = join(args.mainInspectorDir, ".env.development.local");
    read("main worktree profile (read in place)", main);
  }
  return { target, explicit: false, layers };
}

function previewLayer(urls) {
  const [viteConvexUrl, convexHttpUrl] = urls ?? [];
  if (!nonEmpty(viteConvexUrl) || !nonEmpty(convexHttpUrl)) {
    throw new RuntimeConfigError(
      "The preview target needs explicit VITE_CONVEX_URL and CONVEX_HTTP_URL arguments.",
    );
  }
  return {
    name: "preview",
    values: {
      WORKOS_CLIENT_ID: STAGING_WORKOS_CLIENT_ID,
      VITE_WORKOS_CLIENT_ID: STAGING_WORKOS_CLIENT_ID,
      VITE_CONVEX_URL: viteConvexUrl,
      CONVEX_URL: viteConvexUrl,
      CONVEX_HTTP_URL: convexHttpUrl,
    },
  };
}

/**
 * Validate and normalize a merged profile into the settings the children get.
 * Throws `RuntimeConfigError` with an actionable message; never echoes a
 * secret value.
 */
export function finalizeProfile(
  merged,
  { explicit, standardLayerName, standardBackends },
) {
  const values = { ...merged.values };
  const errors = [];

  const backendFrom = merged.groupSource.backend
    ? ` (backend settings come from the ${merged.groupSource.backend}, which must name its backend as a whole)`
    : "";
  const httpUrl = nonEmpty(values.CONVEX_HTTP_URL);
  const viteUrl =
    nonEmpty(values.VITE_CONVEX_URL) ?? nonEmpty(values.CONVEX_URL);
  if (!httpUrl)
    errors.push(
      `CONVEX_HTTP_URL is not set by the selected profile${backendFrom}.`,
    );
  if (!viteUrl)
    errors.push(
      `VITE_CONVEX_URL is not set by the selected profile${backendFrom}.`,
    );
  if (viteUrl && !nonEmpty(values.VITE_CONVEX_URL))
    values.VITE_CONVEX_URL = viteUrl;
  if (viteUrl && !nonEmpty(values.CONVEX_URL)) values.CONVEX_URL = viteUrl;
  const httpSlug = httpUrl ? convexSlug(httpUrl) : null;
  const viteSlug = viteUrl ? convexSlug(viteUrl) : null;
  if (httpSlug && viteSlug && httpSlug !== viteSlug) {
    errors.push(
      `VITE_CONVEX_URL (${viteSlug}) and CONVEX_HTTP_URL (${httpSlug}) name different deployments.`,
    );
  }

  const workosA = nonEmpty(values.WORKOS_CLIENT_ID);
  const workosB = nonEmpty(values.VITE_WORKOS_CLIENT_ID);
  if (workosA && workosB && workosA !== workosB) {
    errors.push("WORKOS_CLIENT_ID and VITE_WORKOS_CLIENT_ID disagree.");
  }
  const workosClientId = workosA ?? workosB;
  if (!workosClientId && merged.groupSource.auth) {
    errors.push(
      `The ${merged.groupSource.auth} sets sign-in settings but no WORKOS_CLIENT_ID; ` +
        "a profile that sets any sign-in setting must name its WorkOS client.",
    );
  }
  if (workosClientId) {
    values.WORKOS_CLIENT_ID = workosClientId;
    values.VITE_WORKOS_CLIENT_ID = workosClientId;
  }

  // The standard OSS profile needs no developer secrets: its guest authority
  // is the hosted Inspector, through a pairing operators manage. That is a
  // property of the BACKEND — one of the committed standard profiles' — not of
  // how it was selected, so `--env-file .env.local` is standard too. Any other
  // backend must say which authority it uses and carry its credentials.
  let httpOrigin = null;
  try {
    httpOrigin = httpUrl ? new URL(httpUrl).origin : null;
  } catch {
    httpOrigin = null;
  }
  const standard =
    (!explicit && merged.groupSource.backend === standardLayerName) ||
    (httpOrigin !== null && (standardBackends ?? []).includes(httpOrigin));
  const authority = nonEmpty(values.MCPJAM_GUEST_AUTHORITY);
  const secret = nonEmpty(values.MCPJAM_GUEST_SESSION_SHARED_SECRET);
  if (authority && authority !== "backend" && authority !== "hosted") {
    errors.push(`MCPJAM_GUEST_AUTHORITY must be "backend" or "hosted".`);
  } else if (authority === "backend" && !secret) {
    errors.push(
      "The selected profile uses its backend as the guest authority but has no " +
        "MCPJAM_GUEST_SESSION_SHARED_SECRET. Run `npm run dev:setup-guest-auth -- " +
        "--deployment dev:<name> --env-file <profile>` for your own development " +
        "deployment, or set MCPJAM_GUEST_AUTHORITY=hosted with MCPJAM_GUEST_AUTHORITY_ORIGIN.",
    );
  } else if (!standard && !authority && !secret) {
    errors.push(
      "The selected profile points at a private backend but names no guest " +
        "authority. Add MCPJAM_GUEST_SESSION_SHARED_SECRET (see " +
        "`npm run dev:setup-guest-auth`) or MCPJAM_GUEST_AUTHORITY=hosted with " +
        "MCPJAM_GUEST_AUTHORITY_ORIGIN to the profile.",
    );
  }
  if (!authority) {
    values.MCPJAM_GUEST_AUTHORITY = secret ? "backend" : "hosted";
  }

  if (errors.length > 0) {
    throw new RuntimeConfigError(
      `Configuration for this instance is incomplete:\n  - ${errors.join("\n  - ")}`,
    );
  }
  return { values, standard, workosClientId };
}

// ── ports and origins ───────────────────────────────────────────────────────

export const DEFAULT_PORT_BASES = Object.freeze({
  client: 5173,
  server: 6274,
  worker: 8787,
  debugger: 9229,
});

function parsePortValue(name, raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const text = String(raw);
  const port = Number(text);
  if (
    !/^\d+$/.test(text) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new RuntimeConfigError(
      `${name} must be a port number between 1 and 65535 (got "${text}").`,
    );
  }
  return port;
}

/** Ports for instance N, with explicit overrides; all distinct. */
export function computeInstancePorts(instance, overrides = {}) {
  if (!Number.isInteger(instance) || instance < 0) {
    throw new RuntimeConfigError(
      "The instance must be a non-negative integer.",
    );
  }
  const ports = {
    client:
      parsePortValue("--client-port", overrides.client) ??
      DEFAULT_PORT_BASES.client + instance,
    server:
      parsePortValue("--server-port", overrides.server) ??
      DEFAULT_PORT_BASES.server + instance,
    worker:
      parsePortValue("--worker-port", overrides.worker) ??
      DEFAULT_PORT_BASES.worker + instance,
    debugger:
      parsePortValue("--debugger-port", overrides.debugger) ??
      DEFAULT_PORT_BASES.debugger + instance,
  };
  const seen = new Map();
  for (const [role, port] of Object.entries(ports)) {
    if (port > 65535) {
      throw new RuntimeConfigError(
        `The ${role} port for instance ${instance} would be ${port}.`,
      );
    }
    if (seen.has(port)) {
      throw new RuntimeConfigError(
        `The ${seen.get(port)} and ${role} ports are both ${port}; give each its own port.`,
      );
    }
    seen.set(port, role);
  }
  return ports;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackOrigin(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      LOOPBACK_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * The per-instance addresses.
 *
 * `browserPort` is where the browser loads the app (the Vite client in
 * development, the server itself when packaged). Public callback origins for
 * CLI login and Slack/Discord linking follow it; a profile value that names a
 * NON-loopback origin is a deliberate public deployment and is kept.
 */
export function computeInstanceEnv({
  ports,
  browserPort,
  host = "localhost",
  profile = {},
  withWorker = false,
}) {
  const browserOrigin = `http://${host}:${browserPort}`;
  const serverOrigin = `http://${host}:${ports.server}`;
  const keepPublic = (name) => {
    const value = nonEmpty(profile[name]);
    return value && !isLoopbackOrigin(value)
      ? new URL(value).origin
      : undefined;
  };
  const cliOrigin = keepPublic("CLI_AUTH_PUBLIC_ORIGIN") ?? browserOrigin;
  const extraOrigins = (profile.WEB_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin && !isLoopbackOrigin(origin));
  const env = {
    MCPJAM_BROWSER_PORT: String(browserPort),
    SERVER_PORT: String(ports.server),
    PORT: String(ports.server),
    BASE_URL: serverOrigin,
    WEB_ALLOWED_ORIGINS: [
      `http://localhost:${browserPort}`,
      `http://127.0.0.1:${browserPort}`,
      ...extraOrigins,
    ].join(","),
    CLI_AUTH_PUBLIC_ORIGIN: cliOrigin,
    SLACK_LINK_PUBLIC_ORIGIN:
      keepPublic("SLACK_LINK_PUBLIC_ORIGIN") ?? cliOrigin,
    DISCORD_LINK_PUBLIC_ORIGIN:
      keepPublic("DISCORD_LINK_PUBLIC_ORIGIN") ?? cliOrigin,
    MCPJAM_INSPECTOR_FRONTEND_URL: browserOrigin,
  };
  if (ports.client !== undefined) {
    env.CLIENT_PORT = String(ports.client);
    env.VITE_API_BASE_URL = serverOrigin;
  }
  if (withWorker) {
    env.MCPJAM_PLATFORM_MCP_URL = `http://localhost:${ports.worker}/mcp`;
  }
  return env;
}

/**
 * Variables the platform MCP worker gets for this instance, written to the
 * env file `wrangler dev` reads INSTEAD of `.dev.vars`/`.env`.
 */
export function computeWorkerVars({ ports, profile }) {
  const serverOrigin = `http://localhost:${ports.server}`;
  const clientId =
    nonEmpty(profile.WORKOS_CLIENT_ID) ??
    nonEmpty(profile.VITE_WORKOS_CLIENT_ID);
  const authkitDomain =
    nonEmpty(profile.AUTHKIT_DOMAIN) ??
    (clientId ? KNOWN_AUTHKIT_DOMAINS[clientId] : undefined);
  return {
    PLATFORM_API_URL: `${serverOrigin}/api/v1`,
    MCPJAM_APP_ORIGIN: serverOrigin,
    MCPJAM_GUEST_JWKS_URL: `${serverOrigin}/api/web/guest-jwks`,
    MCPJAM_GUEST_MINT_URL: `${serverOrigin}/api/web/guest-token`,
    ...(clientId ? { WORKOS_CLIENT_ID: clientId } : {}),
    ...(authkitDomain ? { AUTHKIT_DOMAIN: authkitDomain } : {}),
  };
}

/**
 * The environment a child process starts with: the launcher's own
 * environment MINUS every profile-owned key (so nothing inherited from the
 * shell or another target survives), plus the resolved profile, plus this
 * instance's addresses, plus the marker that tells the child not to load
 * configuration files of its own.
 */
export function buildChildEnv({ baseEnv, profileValues, instanceEnv }) {
  const env = {};
  const dropped = [];
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (isProfileOwnedKey(key)) {
      if (!(key in profileValues) && !(key in instanceEnv) && value !== "")
        dropped.push(key);
      continue;
    }
    env[key] = value;
  }
  Object.assign(env, profileValues, instanceEnv, {
    [RESOLVED_RUNTIME_MARKER]: "1",
  });
  return { env, droppedInheritedKeys: dropped.sort() };
}

/** A printable, secret-free description of a resolved profile. */
export function describeProfile({ values, sources }) {
  const lines = [];
  for (const key of Object.keys(values).sort()) {
    if (!isProfileOwnedKey(key)) continue;
    const shown = SECRET_NAME.test(key) ? "<set>" : values[key];
    lines.push(`${key}=${shown}${sources?.[key] ? `  (${sources[key]})` : ""}`);
  }
  return lines;
}

/** The main worktree's mcpjam-inspector dir, or null when this IS the main worktree. */
export function findMainInspectorDir(inspectorDir, gitCommonDir) {
  if (!gitCommonDir) return null;
  const mainRoot = dirname(resolve(gitCommonDir));
  const main = join(mainRoot, "mcpjam-inspector");
  return resolve(main) === resolve(inspectorDir) ? null : main;
}

/**
 * The backends of the committed standard OSS profiles (`.env.local` for
 * source checkouts, `.env.production` for packaged releases).
 */
export function standardBackendOrigins(inspectorDir, fs) {
  const origins = [];
  for (const name of [".env.local", ".env.production"]) {
    const values = readEnvFile(join(inspectorDir, name), fs);
    try {
      if (values?.CONVEX_HTTP_URL)
        origins.push(new URL(values.CONVEX_HTTP_URL).origin);
    } catch {
      // not a URL; not a standard backend
    }
  }
  return origins;
}

/** End-to-end resolution for a launcher. */
export function resolveRuntimeProfile(args) {
  const layerSet = resolveProfileLayers(args);
  const merged = mergeProfileLayers(layerSet.layers);
  const finalized = finalizeProfile(merged, {
    explicit: layerSet.explicit,
    standardLayerName: "standard profile (.env.local)",
    standardBackends: standardBackendOrigins(args.inspectorDir, args.fs),
  });
  return {
    target: layerSet.target,
    explicit: layerSet.explicit,
    layers: layerSet.layers.map(({ name, path }) => ({ name, path })),
    values: finalized.values,
    sources: merged.sources,
    instanceHints: merged.instanceHints,
    standard: finalized.standard,
  };
}
