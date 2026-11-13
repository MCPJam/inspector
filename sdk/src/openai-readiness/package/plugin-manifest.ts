/**
 * Read the plugin manifest the import parser's `findPluginRoot` located, as
 * evidence: its JSON, the Agent Plugins schema a root `plugin.json` needs, the
 * portal's `name` rules, a semantic version, and the servers its layout
 * declares.
 *
 * Pure aside from the caller's `read`. Safe from the browser entry.
 */

import { LEGACY_MCP_CONFIG_PATH } from "../../plugin-bundle/layout.js";
import { PLUGIN_MANIFEST_SCHEMAS } from "../../plugin-bundle/manifest.js";
import { MCP_CONFIG_PATH } from "../../plugin-bundle/parse.js";
import { portalPluginNameRefusals } from "../../plugin-bundle/plugin-name.js";
import type { PluginManifestLocation } from "../../plugin-bundle/plugin-root.js";
import { openaiPortalIssue, type OpenAIPortalIssue } from "../portal-errors.js";
import { OPENAI_MANIFEST_LOCATIONS } from "../profile.js";
import type {
  OpenAIManifestLocation,
  OpenAIPackageGap,
  OpenAIPackageManifest,
} from "./reader.js";

export interface PluginManifestReadContext {
  /** The plugin's files, keyed by path relative to the plugin root. */
  files: ReadonlyMap<string, unknown>;
  read(path: string): Promise<{ bytes?: Uint8Array; error?: string }>;
  issues: OpenAIPortalIssue[];
  gaps: OpenAIPackageGap[];
}

const decoder = new TextDecoder("utf-8", { fatal: false });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readStringField(
  container: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = container?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Server names from a `.mcp.json`-shaped document, in either spelling. */
function readServerNames(document: unknown): string[] {
  if (typeof document !== "object" || document === null) return [];
  const container = document as Record<string, unknown>;
  const map = container.mcpServers ?? container.servers;
  if (typeof map !== "object" || map === null || Array.isArray(map)) return [];
  return Object.keys(map as Record<string, unknown>);
}

export async function readPluginManifest(
  located: PluginManifestLocation,
  { files, read, issues, gaps }: PluginManifestReadContext,
): Promise<OpenAIPackageManifest> {
  const manifestPath = located.path;
  let manifest: OpenAIPackageManifest;
  const canonical =
    manifestPath === OPENAI_MANIFEST_LOCATIONS.portable ||
    manifestPath === OPENAI_MANIFEST_LOCATIONS.canonical;
  const location: OpenAIManifestLocation = {
    path: manifestPath,
    canonical,
    normalizedFrom: canonical ? undefined : manifestPath,
  };

  const { bytes, error } = await read(manifestPath);
  if (!bytes) {
    issues.push(
      openaiPortalIssue("manifest-invalid-json", {
        subject: manifestPath,
        observed: error,
      }),
    );
    manifest = { location, mcpServerNames: [] };
  } else {
    let parsed: Record<string, unknown> | undefined;
    try {
      const value: unknown = JSON.parse(decoder.decode(bytes));
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        parsed = value as Record<string, unknown>;
      } else {
        issues.push(
          openaiPortalIssue("manifest-invalid-json", {
            subject: manifestPath,
            observed: "the document is not a JSON object",
          }),
        );
      }
    } catch (parseError) {
      issues.push(
        openaiPortalIssue("manifest-invalid-json", {
          subject: manifestPath,
          observed:
            parseError instanceof Error
              ? parseError.message
              : String(parseError),
        }),
      );
    }

    const name = readStringField(parsed, "name");
    const version = readStringField(parsed, "version");

    // The portal reads a root `plugin.json` as a manifest only when it names
    // a supported Agent Plugins schema.
    const schema = parsed?.$schema;
    if (
      parsed &&
      located.layout === "agent-plugins" &&
      !Object.values(PLUGIN_MANIFEST_SCHEMAS).includes(String(schema))
    ) {
      issues.push(
        openaiPortalIssue("plugin_manifest_missing", {
          subject: manifestPath,
          observed: typeof schema === "string" ? schema : undefined,
        }),
      );
    }
    for (const code of parsed ? portalPluginNameRefusals(parsed.name) : []) {
      issues.push(
        openaiPortalIssue(code, { subject: manifestPath, observed: name }),
      );
    }

    // Semver, deliberately without a dependency: the portal wants a version
    // it can order, and `1.0` is the mistake this catches.
    if (
      version !== undefined &&
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
        version,
      )
    ) {
      issues.push(
        openaiPortalIssue("manifest-version-invalid", {
          subject: manifestPath,
          observed: version,
        }),
      );
    }

    // An Agent Plugins package declares its servers in `mcp.json`, as the
    // import parser reads it; the other layouts in the manifest or
    // `.mcp.json`.
    const configPath =
      located.layout === "agent-plugins"
        ? MCP_CONFIG_PATH
        : LEGACY_MCP_CONFIG_PATH;
    let mcpConfig: OpenAIPackageManifest["mcpConfig"];
    const serverNames = new Set(readServerNames(parsed));
    if (files.has(configPath)) {
      const config = await read(configPath);
      if (config.bytes) {
        try {
          const document: unknown = JSON.parse(decoder.decode(config.bytes));
          for (const serverName of readServerNames(document)) {
            serverNames.add(serverName);
          }
          if (isRecord(document)) mcpConfig = { path: configPath, document };
        } catch {
          // A malformed configuration is not a manifest problem; it surfaces as
          // an unreadable server list rather than a JSON error against the
          // manifest's own path.
          gaps.push({
            subject: configPath,
            reason:
              "the MCP configuration is not valid JSON, so its servers could not be listed",
          });
        }
      }
    }

    manifest = {
      location,
      raw: parsed,
      name,
      version,
      description: readStringField(parsed, "description"),
      mcpServerNames: [...serverNames].sort(),
      ...(mcpConfig ? { mcpConfig } : {}),
    };
  }
  return manifest;
}
