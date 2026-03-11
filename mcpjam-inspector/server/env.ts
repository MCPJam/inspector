import dotenv from "dotenv";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { logger as appLogger } from "./utils/logger.js";

export type InspectorEnvMode = "development" | "production";

export interface LoadedInspectorEnv {
  cwd: string;
  envDir: string;
  loadedFiles: string[];
  mode: InspectorEnvMode;
}

function getInspectorEnvMode(): InspectorEnvMode {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

export function getInspectorEnvFileNames(
  mode: InspectorEnvMode = getInspectorEnvMode(),
): string[] {
  return [`.env.${mode}.local`, ".env.local", `.env.${mode}`, ".env"];
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

export function loadInspectorEnv(serverDir: string): LoadedInspectorEnv {
  const mode = getInspectorEnvMode();
  const envDir = resolveInspectorEnvDir(serverDir);
  const loadedFiles: string[] = [];

  for (const fileName of getInspectorEnvFileNames(mode)) {
    const envPath = join(envDir, fileName);
    if (!existsSync(envPath)) continue;

    dotenv.config({ path: envPath });
    loadedFiles.push(envPath);
  }

  if (!process.env.CONVEX_HTTP_URL) {
    throw new Error(
      `CONVEX_HTTP_URL is required but not set. Loaded from: ${loadedFiles.join(", ") || "(none)"}`,
    );
  }

  return {
    cwd: process.cwd(),
    envDir,
    loadedFiles,
    mode,
  };
}

function getConvexDeploymentSlug(url: string | undefined): string | null {
  if (!url) return null;

  try {
    return new URL(url).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

async function checkBootstrapRoute(convexHttpUrl: string): Promise<void> {
  const response = await fetch(`${convexHttpUrl}/sandbox/bootstrap`, {
    method: "OPTIONS",
    signal: AbortSignal.timeout(2_000),
  });

  if (response.status === 404) {
    appLogger.warn(
      `[boot] CONVEX_HTTP_URL does not expose /sandbox/bootstrap. cwd=${process.cwd()} CONVEX_HTTP_URL=${convexHttpUrl}`,
    );
  }
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

  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  const viteConvexUrl = process.env.VITE_CONVEX_URL;

  const httpSlug = getConvexDeploymentSlug(convexHttpUrl);
  const viteSlug = getConvexDeploymentSlug(viteConvexUrl);

  if (httpSlug && viteSlug && httpSlug !== viteSlug) {
    appLogger.warn(
      `[boot] Client/server Convex deployment mismatch detected. cwd=${env.cwd} VITE_CONVEX_URL=${viteConvexUrl} CONVEX_HTTP_URL=${convexHttpUrl}`,
    );
  }

  if (!convexHttpUrl) return;

  void checkBootstrapRoute(convexHttpUrl).catch((error) => {
    appLogger.warn(
      `[boot] Failed to verify /sandbox/bootstrap on CONVEX_HTTP_URL. cwd=${env.cwd} CONVEX_HTTP_URL=${convexHttpUrl} error=${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
