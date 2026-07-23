/**
 * Shared plugin-bundle contract — pure DTOs and the abstract file source.
 *
 * This module is the SDK-owned wire/persistence contract for OpenAI plugin
 * imports (see docs/plans/openai-plugin-import-cross-repo.md, PR SDK-1). The
 * parser never touches the filesystem or archive libraries: backend and
 * inspector adapters implement `PluginFileSource` over their own extraction
 * paths and get byte-identical normalization and hashing.
 */

import type { NormalizedPluginManifest } from "./manifest.js";
import type { ParsedPluginServer } from "./mcp-config.js";
import type { ParsedPluginSkill } from "./skill.js";
import type { ParsedPluginApp } from "./app-config.js";
import type { PluginValidationIssue } from "./validation.js";

export interface PluginFileEntry {
  /** Entry path as reported by the source adapter (ZIP entry name or relative file path). */
  path: string;
  /** Declared uncompressed size in bytes. */
  size: number;
  /**
   * Entry kind. Adapters MUST surface link entries (`symlink`/`hardlink`) so
   * the parser can reject them; omitted means `file`.
   */
  kind?: "file" | "directory" | "symlink" | "hardlink";
}

/**
 * Abstract source of bundle content. Adapters must enforce `maxBytes`: when an
 * entry's content exceeds it, throw instead of returning truncated data.
 */
export interface PluginFileSource {
  list(): Promise<PluginFileEntry[]>;
  /**
   * Optional convenience for adapter-side consumers. The parser itself never
   * calls it — it decodes text from `readBytes` so hashing and decoding see
   * the same bytes.
   */
  readText?(path: string, maxBytes: number): Promise<string>;
  readBytes(path: string, maxBytes: number): Promise<Uint8Array>;
}

export interface PluginBundleLimits {
  /** Maximum archive entries (files + directories). */
  maxEntries: number;
  /** Maximum total uncompressed content in bytes. */
  maxTotalBytes: number;
  /** Maximum size of one ordinary file in bytes. */
  maxFileBytes: number;
  /** Maximum path length in UTF-8 bytes. */
  maxPathBytes: number;
  /** Maximum path nesting depth (segments). */
  maxPathDepth: number;
  /** Maximum skills per plugin (V1). */
  maxSkills: number;
  /** Maximum MCP server entries per plugin (V1). */
  maxMcpServers: number;
}

/** Locked V1 limits from the import plan ("Archive and path limits"). */
export const DEFAULT_PLUGIN_BUNDLE_LIMITS: PluginBundleLimits = {
  maxEntries: 1000,
  maxTotalBytes: 100 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxPathBytes: 512,
  maxPathDepth: 20,
  maxSkills: 20,
  maxMcpServers: 20,
};

export type PluginAssetKind = "icon" | "logo" | "screenshot" | "other";

export interface ParsedPluginAsset {
  /** Canonical bundle-relative path. */
  path: string;
  kind: PluginAssetKind;
  size: number;
  /** SHA-256 hex of the asset's exact bytes. */
  contentHash: string;
  /** MIME type inferred from the file extension. */
  contentType: string;
}

export type PluginUnsupportedComponentKind =
  | "hooks"
  | "browser-extension"
  | "scheduled-task"
  | "manifest-field"
  | "other";

/** A component MCPJam preserves in the source bundle but does not execute. */
export interface ParsedUnsupportedComponent {
  kind: PluginUnsupportedComponentKind;
  /** Stable key: top-level directory name or manifest field name. */
  key: string;
  /** Bundle paths belonging to this component (empty for manifest fields). */
  paths: string[];
  reason: string;
}

/**
 * Setup the user must complete before a component is runnable. Derived from
 * requirement NAMES only — the bundle never supplies credential values.
 */
export type PluginSetupRequirement =
  | {
      kind: "env";
      componentKey: string;
      serverKey: string;
      name: string;
      required: boolean;
    }
  | {
      kind: "header";
      componentKey: string;
      serverKey: string;
      name: string;
      secret: boolean;
    }
  | {
      kind: "oauth";
      componentKey: string;
      serverKey: string;
      timing?: "on_install" | "on_use";
    };

export interface ParsedPluginBundle {
  manifest: NormalizedPluginManifest;
  /** Deterministic content hash over every file (canonical path + bytes). */
  bundleHash: string;
  /** SHA-256 hex of the raw `.codex-plugin/plugin.json` bytes. */
  manifestHash: string;
  skills: ParsedPluginSkill[];
  mcpServers: ParsedPluginServer[];
  apps: ParsedPluginApp[];
  assets: ParsedPluginAsset[];
  unsupported: ParsedUnsupportedComponent[];
  setupRequirements: PluginSetupRequirement[];
  /** Warning-severity issues only; error-severity issues throw instead. */
  warnings: PluginValidationIssue[];
}

export interface ParsePluginBundleOptions {
  /** Override individual archive/component limits (tests, paid plans). */
  limits?: Partial<PluginBundleLimits>;
}
