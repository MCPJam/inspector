import dotenv from "dotenv";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { tryGetGuestAuthority } from "./utils/guest-authority.js";
import { logger as appLogger } from "./utils/logger.js";

export type InspectorEnvMode = "development" | "production";

export interface LoadedInspectorEnv {
  cwd: string;
  envDir: string;
  loadedFiles: string[];
  mode: InspectorEnvMode;
}

export interface InspectorClientRuntimeConfig {
  convexUrl?: string;
  convexSiteUrl?: string;
  workosClientId?: string;
  workosApiHostname?: string;
}

function getInspectorEnvMode(): InspectorEnvMode {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

export function getInspectorEnvFileNames(
  mode: InspectorEnvMode = getInspectorEnvMode(),
): string[] {
  return [`.env.${mode}.local`, `.env.${mode}`, ".env.local", ".env"];
}

export function resolveInspectorEnvDir(serverDir: string): string {
  if (
    process.env.IS_PACKAGED === "true" &&
    typeof (process as any).resourcesPath === "string"
  ) {
    return (process as any).resourcesPath;
  }

  if (process.env.ELECTRON_APP === "true") {
    return process.env.ELECTRON_RESOURCES_PATH || ".";
  }

  const envFileNames = getInspectorEnvFileNames();
  const candidateDirs = [
    process.cwd(),
    resolve(serverDir, ".."),
    resolve(serverDir, "..", ".."),
  ];

  for (const candidateDir of candidateDirs) {
    if (
      !existsSync(candidateDir) ||
      !envFileNames.some((fileName) => existsSync(join(candidateDir, fileName)))
    ) {
      continue;
    }

    return candidateDir;
  }

  return process.cwd();
}

/**
 * Set by a launcher that already resolved this instance's configuration
 * (`bin/runtime-profile.mjs`): the environment it passed IS the configuration.
 */
export const RESOLVED_RUNTIME_MARKER = "MCPJAM_RESOLVED_RUNTIME";

export function isResolvedRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[RESOLVED_RUNTIME_MARKER] === "1";
}

export function loadInspectorEnv(serverDir: string): LoadedInspectorEnv {
  const mode = getInspectorEnvMode();
  const envDir = resolveInspectorEnvDir(serverDir);
  const loadedFiles: string[] = [];

  // Under a launcher-resolved runtime no file is read: dotenv never overrides
  // a variable that is set, but it DOES fill one that is missing, which is
  // exactly how a value the selected profile deliberately left out used to
  // come back from another target's `.env` file.
  if (!isResolvedRuntime()) {
    for (const fileName of getInspectorEnvFileNames(mode)) {
      const envPath = join(envDir, fileName);
      if (!existsSync(envPath)) continue;

      dotenv.config({ path: envPath });
      loadedFiles.push(envPath);
    }
  }

  if (!process.env.CONVEX_HTTP_URL) {
    throw new Error(
      isResolvedRuntime()
        ? "CONVEX_HTTP_URL is required but the launcher-resolved configuration does not set it."
        : `CONVEX_HTTP_URL is required but not set. Loaded from: ${loadedFiles.join(", ") || "(none)"}`,
    );
  }

  return {
    cwd: process.cwd(),
    envDir,
    loadedFiles,
    mode,
  };
}

function normalizeUrlOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;

  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function replaceConvexHostnameSuffix(
  url: string | undefined,
  fromSuffix: string,
  toSuffix: string,
): string | undefined {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith(fromSuffix)) {
      return undefined;
    }
    parsed.hostname = parsed.hostname.replace(fromSuffix, toSuffix);
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function getNonEmptyEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getInspectorClientRuntimeConfig(): InspectorClientRuntimeConfig {
  const convexSiteUrl =
    normalizeUrlOrigin(process.env.CONVEX_HTTP_URL) ??
    replaceConvexHostnameSuffix(
      process.env.VITE_CONVEX_URL,
      ".convex.cloud",
      ".convex.site",
    );

  const convexUrl =
    replaceConvexHostnameSuffix(
      process.env.CONVEX_HTTP_URL,
      ".convex.site",
      ".convex.cloud",
    ) ?? normalizeUrlOrigin(process.env.VITE_CONVEX_URL);

  // WorkOS client config is served at runtime rather than inlined by Vite.
  // A build-time value has to be listed in THREE places that are maintained by
  // hand — the Railway service variables, the `ARG` allowlist in
  // `mcpjam-inspector/Dockerfile`, and the environment it is set for — and a
  // value present in one but missing from another produces a client that is
  // silently misconfigured rather than one that fails to build. Staging shipped
  // without `VITE_WORKOS_API_HOSTNAME` for months: its AuthKit refresh went
  // cross-site to `api.workos.com`, the session cookie was never sent, and
  // every page load ended in a 400 that wiped the session. Read here, the same
  // variable takes effect on restart, in every environment, with no rebuild.
  //
  // The unprefixed names are canonical; the `VITE_`-prefixed ones are accepted
  // so an environment already carrying the build-time variable keeps working
  // through the migration.
  const workosClientId =
    getNonEmptyEnv("WORKOS_CLIENT_ID") ??
    getNonEmptyEnv("VITE_WORKOS_CLIENT_ID");

  const workosApiHostname =
    getNonEmptyEnv("WORKOS_API_HOSTNAME") ??
    getNonEmptyEnv("VITE_WORKOS_API_HOSTNAME");

  return {
    convexUrl,
    convexSiteUrl,
    workosClientId,
    workosApiHostname,
  };
}

/**
 * The backend origins this deployment is configured with.
 *
 * `api` is the Convex API origin, which also serves file storage
 * (`/api/storage/…`); `http` is the HTTP-actions origin (`/web/artifact`,
 * the control-plane routes). Each is read from the variables that name it —
 * `CONVEX_URL` and `VITE_CONVEX_URL` for the API, `CONVEX_HTTP_URL` for HTTP
 * actions — and, on Convex's default hosts only, the other half of the same
 * deployment is derived by suffix (`<name>.convex.cloud` ↔
 * `<name>.convex.site`), exactly as `getInspectorClientRuntimeConfig` does. A
 * custom domain (`rt.mcpjam.com`, `rt-http.mcpjam.com`) is used as configured,
 * and nothing is derived from it.
 */
export function getConfiguredConvexOrigins(): {
  api: string[];
  http: string[];
} {
  const api = new Set<string>();
  const http = new Set<string>();
  const add = (set: Set<string>, origin: string | undefined) => {
    if (origin) set.add(origin);
  };
  for (const name of ["CONVEX_URL", "VITE_CONVEX_URL"]) {
    const value = getNonEmptyEnv(name);
    add(api, normalizeUrlOrigin(value));
    add(
      http,
      replaceConvexHostnameSuffix(value, ".convex.cloud", ".convex.site"),
    );
  }
  const httpValue = getNonEmptyEnv("CONVEX_HTTP_URL");
  add(http, normalizeUrlOrigin(httpValue));
  add(
    api,
    replaceConvexHostnameSuffix(httpValue, ".convex.site", ".convex.cloud"),
  );
  return { api: Array.from(api), http: Array.from(http) };
}

export function getInspectorClientRuntimeConfigScript(): string | null {
  const runtimeConfig = getInspectorClientRuntimeConfig();
  if (!Object.values(runtimeConfig).some((value) => value !== undefined)) {
    return null;
  }

  const serializedConfig = JSON.stringify(runtimeConfig).replace(
    /</g,
    "\\u003c",
  );
  return `<script>window.__MCP_RUNTIME_CONFIG__=${serializedConfig};</script>`;
}

function getConvexDeploymentSlug(url: string | undefined): string | null {
  if (!url) return null;

  try {
    return new URL(url).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

// The first hostname label is the deployment name only on Convex's default
// hosts. On a custom domain (`rt.mcpjam.com` / `rt-http.mcpjam.com` both front
// the production deployment) the labels legitimately differ, so a slug
// comparison there would only ever produce a false mismatch warning.
function isConvexDefaultHost(url: string | undefined): boolean {
  if (!url) return false;

  try {
    const { hostname } = new URL(url);
    return (
      hostname.endsWith(".convex.cloud") || hostname.endsWith(".convex.site")
    );
  } catch {
    return false;
  }
}

async function checkBootstrapRoute(convexHttpUrl: string): Promise<void> {
  const response = await fetch(`${convexHttpUrl}/scenario/bootstrap`, {
    method: "OPTIONS",
    signal: AbortSignal.timeout(2_000),
  });

  if (response.status === 404) {
    appLogger.warn(
      `[boot] CONVEX_HTTP_URL does not expose /scenario/bootstrap. cwd=${process.cwd()} CONVEX_HTTP_URL=${convexHttpUrl}`,
    );
  }
}

/**
 * A developer overlay (`.env.development.local`) that names a backend other
 * than the standard profile's, while guest sessions still come from the
 * HOSTED guest authority: every guest token is then signed by the hosted
 * Inspector's keys and refused by the private backend (401 on each guest
 * call). The launcher (`npm run dev:worktree`) refuses this before starting;
 * `npm run dev` reads the files directly and only has this warning.
 *
 * Pure, for tests: the warning text, or null when the setup is coherent.
 */
export function describeGuestAuthorityMismatch(args: {
  standardConvexHttpUrl: string | undefined;
  overlayConvexHttpUrl: string | undefined;
  guestAuthorityKind: "backend" | "hosted" | null;
}): string | null {
  const standard = normalizeUrlOrigin(args.standardConvexHttpUrl);
  const overlay = normalizeUrlOrigin(args.overlayConvexHttpUrl);
  if (!standard || !overlay || overlay === standard) return null;
  if (args.guestAuthorityKind !== "hosted") return null;
  return (
    `[boot] .env.development.local points CONVEX_HTTP_URL at ${overlay}, but guest ` +
    "sessions come from the hosted guest authority, whose tokens that backend will " +
    "refuse (every guest call answers 401). Run `npm run dev:setup-guest-auth -- " +
    "--deployment dev:<name>` once for your own deployment, or start with " +
    "`npm run dev:worktree -- <N>`, which checks this before launching."
  );
}

function readEnvFileValues(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  try {
    return dotenv.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function warnOnGuestAuthorityMismatch(env: LoadedInspectorEnv): void {
  // Under a launcher-resolved runtime the launcher already refused this.
  if (isResolvedRuntime()) return;
  const overlay = readEnvFileValues(join(env.envDir, ".env.development.local"));
  if (!overlay?.CONVEX_HTTP_URL) return;
  const standard = readEnvFileValues(join(env.envDir, ".env.local"));
  const authority = tryGetGuestAuthority();
  const warning = describeGuestAuthorityMismatch({
    standardConvexHttpUrl: standard?.CONVEX_HTTP_URL,
    overlayConvexHttpUrl: overlay.CONVEX_HTTP_URL,
    guestAuthorityKind: authority.ok ? authority.authority.kind : null,
  });
  if (warning) appLogger.warn(warning);
}

export function warnOnConvexDevMisconfiguration(env: LoadedInspectorEnv): void {
  if (
    env.mode === "production" ||
    process.env.NODE_ENV === "test" ||
    (
      globalThis as typeof globalThis & {
        __MCPJAM_CONVEX_DIAGNOSTICS_STARTED__?: boolean;
      }
    ).__MCPJAM_CONVEX_DIAGNOSTICS_STARTED__
  ) {
    return;
  }

  (
    globalThis as typeof globalThis & {
      __MCPJAM_CONVEX_DIAGNOSTICS_STARTED__?: boolean;
    }
  ).__MCPJAM_CONVEX_DIAGNOSTICS_STARTED__ = true;

  warnOnGuestAuthorityMismatch(env);

  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  const viteConvexUrl = process.env.VITE_CONVEX_URL;

  const httpSlug = isConvexDefaultHost(convexHttpUrl)
    ? getConvexDeploymentSlug(convexHttpUrl)
    : null;
  const viteSlug = isConvexDefaultHost(viteConvexUrl)
    ? getConvexDeploymentSlug(viteConvexUrl)
    : null;

  if (httpSlug && viteSlug && httpSlug !== viteSlug) {
    appLogger.warn(
      `[boot] Client/server Convex deployment mismatch detected. cwd=${env.cwd} VITE_CONVEX_URL=${viteConvexUrl} CONVEX_HTTP_URL=${convexHttpUrl}`,
    );
  }

  if (!convexHttpUrl) return;

  void checkBootstrapRoute(convexHttpUrl).catch((error) => {
    appLogger.warn(
      `[boot] Failed to verify /scenario/bootstrap on CONVEX_HTTP_URL. cwd=${env.cwd} CONVEX_HTTP_URL=${convexHttpUrl} error=${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
