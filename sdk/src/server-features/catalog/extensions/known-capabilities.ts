/**
 * Capability keys the catalog knows, so `third-party.unrecognized-capabilities`
 * can list everything else a server declares. Covers every top-level server
 * capability in the core schemas (2024-11-05 through 2026-07-28), the
 * extension families' keys, and the settings keys inside each known object.
 * A key listed here with `null` settings is known, but its settings are not
 * checked (their shape is open or undefined by its specification).
 */

import { MCP_UI_EXTENSION_ID } from "../../../mcp-client-manager/capabilities.js";
import { MCP_SKILLS_EXTENSION_ID } from "../../../mcp-client-manager/skills-dispatch.js";
import { MCP_TASKS_EXTENSION_ID } from "../../../mcp-client-manager/tasks-dispatch.js";
import {
  ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION_ID,
  OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID,
} from "./authorization.js";
import { isRecord, type WireRecord } from "./shared.js";

export const OPENAI_SETTINGS_CAPABILITY = "openai/settings";
export const OPENAI_MENTIONS_CAPABILITY = "openai/mentions";
/** Experimental File Uploads and Downloads proposal (experimental-ext-file-uploads). */
export const MCP_FILES_EXTENSION_ID = "io.modelcontextprotocol/files";

type KnownSettings = Readonly<Record<string, readonly string[] | null>>;

/** Top-level `capabilities` keys, with the settings keys each one defines. */
export const KNOWN_SERVER_CAPABILITY_KEYS: KnownSettings = {
  tools: ["listChanged"],
  resources: ["subscribe", "listChanged"],
  prompts: ["listChanged"],
  completions: [],
  logging: [],
  experimental: null,
  extensions: null,
  // Core Tasks utility, 2025-11-25 only.
  tasks: ["list", "cancel", "requests"],
  // MCP Events design sketch: top-level, not an extensions id.
  events: ["listChanged"],
};

/** Ids under `capabilities.extensions`, with their settings keys. */
export const KNOWN_EXTENSION_IDS: KnownSettings = {
  [MCP_UI_EXTENSION_ID]: null,
  [MCP_TASKS_EXTENSION_ID]: [],
  [MCP_SKILLS_EXTENSION_ID]: ["directoryRead"],
  [OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID]: null,
  [ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION_ID]: null,
  [OPENAI_SETTINGS_CAPABILITY]: ["readTool", "updateTool"],
  [OPENAI_MENTIONS_CAPABILITY]: ["searchTool"],
  [MCP_FILES_EXTENSION_ID]: null,
};

/** Keys under `capabilities.experimental` (legacy homes of the same features). */
export const KNOWN_EXPERIMENTAL_KEYS: KnownSettings = {
  tasks: ["list", "cancel", "requests"],
  [OPENAI_SETTINGS_CAPABILITY]: ["readTool", "updateTool"],
  [OPENAI_MENTIONS_CAPABILITY]: ["searchTool"],
  [MCP_FILES_EXTENSION_ID]: null,
};

const MAX_KEY_LENGTH = 64;

function bounded(key: string): string {
  return key.length > MAX_KEY_LENGTH ? `${key.slice(0, MAX_KEY_LENGTH)}…` : key;
}

function unknownKeys(
  container: WireRecord,
  known: KnownSettings,
  path: (key: string) => string,
  out: string[]
): void {
  for (const [key, value] of Object.entries(container)) {
    if (!Object.prototype.hasOwnProperty.call(known, key)) {
      out.push(path(bounded(key)));
      continue;
    }
    const settings = known[key];
    if (settings === null || settings === undefined || !isRecord(value))
      continue;
    for (const setting of Object.keys(value)) {
      if (!settings.includes(setting))
        out.push(`${path(key)}.${bounded(setting)}`);
    }
  }
}

/**
 * Capability, extension and experimental keys (and settings inside known
 * objects) that the catalog does not know, as display paths such as
 * `capabilities.widgets` or `extensions["com.acme/x"]`.
 */
export function unrecognizedCapabilityKeys(capabilities: WireRecord): string[] {
  const out: string[] = [];
  unknownKeys(
    capabilities,
    KNOWN_SERVER_CAPABILITY_KEYS,
    (key) => `capabilities.${key}`,
    out
  );
  const extensions = capabilities.extensions;
  if (isRecord(extensions)) {
    unknownKeys(
      extensions,
      KNOWN_EXTENSION_IDS,
      (key) => `extensions["${key}"]`,
      out
    );
  }
  const experimental = capabilities.experimental;
  if (isRecord(experimental)) {
    unknownKeys(
      experimental,
      KNOWN_EXPERIMENTAL_KEYS,
      (key) => `experimental["${key}"]`,
      out
    );
  }
  return out;
}
