import dotenv from "dotenv";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

function dedupe(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function collectFilenameVariants(mode: string | undefined): string[] {
  const normalizedMode = mode && mode.trim().length > 0 ? mode.trim() : undefined;
  const modeSpecific = normalizedMode
    ? [`.env.${normalizedMode}.local`, `.env.${normalizedMode}`]
    : [];

  const defaults = [
    ".env.production.local",
    ".env.production",
    ".env.development.local",
    ".env.development",
  ];

  const shared = [".env.local", ".env"];

  return dedupe([...modeSpecific, ...defaults, ...shared]);
}

export function loadEnvFromKnownLocations(importMetaUrl: string): string[] {
  const filenames = collectFilenameVariants(process.env.NODE_ENV);

  const moduleDir = dirname(fileURLToPath(importMetaUrl));
  const projectRoot = resolve(moduleDir, "..");
  const packageRoot = resolve(projectRoot, "..");
  const electronResources = process.env.ELECTRON_RESOURCES_PATH;

  const explicitEnvFile = process.env.MCP_ENV_FILE
    ? resolve(process.cwd(), process.env.MCP_ENV_FILE)
    : null;
  const explicitEnvDir = process.env.MCP_ENV_DIR
    ? resolve(process.env.MCP_ENV_DIR)
    : null;

  const baseDirectories = dedupe([
    explicitEnvDir,
    process.cwd(),
    moduleDir,
    projectRoot,
    packageRoot,
    electronResources || null,
  ]);

  const explicitFiles = dedupe([
    explicitEnvFile,
    ...(explicitEnvFile ? filenames.map((name) => resolve(dirname(explicitEnvFile), name)) : []),
  ]);

  const resolvedCandidates = dedupe([
    ...explicitFiles,
    ...baseDirectories.flatMap((dir) => filenames.map((name) => resolve(dir, name))),
  ]);

  const loaded: string[] = [];
  for (const candidate of resolvedCandidates) {
    try {
      if (!existsSync(candidate)) continue;
      const result = dotenv.config({
        path: candidate,
        override: true,
      });
      if (!result.error) {
        loaded.push(candidate);
      }
    } catch (error) {
      // Ignore filesystem errors and continue searching other locations.
    }
  }

  return loaded;
}
