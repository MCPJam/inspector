/**
 * Shared plugin-bundle contract — pure DTOs and the abstract file source.
 *
 * This module is the SDK-owned wire/persistence contract for Agent Plugins
 * 1.0 imports (agent-plugins.org). The parser never touches the filesystem
 * or archive libraries: backend and inspector adapters implement
 * `PluginFileSource` over their own extraction paths and get byte-identical
 * normalization and hashing.
 */

import type { NormalizedPluginManifest } from "./manifest.js";
import type {
  ParsedPluginServer,
  PluginSkippedComponent,
} from "./mcp-config.js";
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
  /**
   * POSIX permission bits, when the source has them (a ZIP made on a POSIX
   * system, a directory on disk). Only the executable bits are read; a browser
   * folder selection has none, so its files are never executable.
   */
  mode?: number;
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
  /** Maximum skills per plugin. */
  maxSkills: number;
  /** Maximum MCP server entries per plugin. */
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

/**
 * Setup the user must complete before a component is runnable. Derived from
 * requirement NAMES only — screened non-secret literals are stored on the
 * normalized config instead and never become requirements; secret-looking
 * values are dropped and DO become requirements.
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
      /** An API key's header: how the credential the user supplies is sent. */
      scheme?: "bearer" | "basic" | "custom_header";
    }
  | {
      kind: "oauth";
      componentKey: string;
      serverKey: string;
      timing?: "on_install" | "on_use";
      /**
       * From OpenAI's declared auth: `true` for `oauth`, `false` for `mixed`,
       * which also serves public access. Absent for MCPJam's own hints.
       */
      required?: boolean;
    };

/** `strict` is Agent Plugins 1.0; `openai-compatible` adds `layout.ts`'s rules. */
export type PluginParserProfile = "strict" | "openai-compatible";

/** Where the manifest came from. Only `agent-plugins` exists under `strict`. */
export type PluginBundleLayout =
  | "agent-plugins"
  | "codex"
  | "agent-legacy"
  | "claude";

/**
 * Parser revision per profile. Bumped whenever the same bytes can normalize
 * differently, so a stored version records which rules produced it.
 */
export const PLUGIN_PARSER_REVISIONS: Readonly<
  Record<PluginParserProfile, number>
> = Object.freeze({ strict: 2, "openai-compatible": 1 });

/** How a bundle was read: the same files under another profile read differently. */
export interface PluginBundleInterpretation {
  profile: PluginParserProfile;
  /** `PLUGIN_PARSER_REVISIONS[profile]` at parse time. */
  revision: number;
  layout: PluginBundleLayout;
  /** Bundle path the manifest was read from. */
  manifestPath: string;
  /** Set when `.codex-plugin/plugin.json` supplied OpenAI data to a root manifest. */
  overlayPath?: string;
}

export interface ParsedPluginBundle {
  manifest: NormalizedPluginManifest;
  interpretation: PluginBundleInterpretation;
  /**
   * Agent Plugins version both documents target (resolved locally from
   * `$schema`). Mirrors `manifest.schemaVersion` for consumers that never
   * look inside the manifest.
   */
  schemaVersion: string;
  /** Deterministic content hash over every file (canonical path + bytes). */
  bundleHash: string;
  /** Canonical paths of files carrying an executable bit, sorted. */
  executableFiles: string[];
  /**
   * Identity of what a runtime materializes and runs: the bundle hash, the
   * executable files, and the interpretation's profile and revision. Two
   * parses that agree on all of these may share a version and a cache entry;
   * ZIP timestamps and compression take no part. A source that can't see
   * modes, such as a browser folder selection, lists no executable files, so
   * its digest matches only another such source's.
   */
  executionDigest: string;
  /** SHA-256 hex of the raw bytes of the manifest file (`interpretation.manifestPath`). */
  manifestHash: string;
  skills: ParsedPluginSkill[];
  mcpServers: ParsedPluginServer[];
  apps: ParsedPluginApp[];
  assets: ParsedPluginAsset[];
  /**
   * Components skipped under the spec's failure-isolation boundaries (one
   * bad server entry / skill / the whole mcp.json document). Import surfaces
   * MUST render these loudly — a silently absent server reads as a runtime
   * bug, not a bundle problem.
   */
  skipped: PluginSkippedComponent[];
  setupRequirements: PluginSetupRequirement[];
  /** Warning-severity issues only; error-severity issues throw instead. */
  warnings: PluginValidationIssue[];
}

export interface ParsePluginBundleOptions {
  /** Override individual archive/component limits (tests, paid plans). */
  limits?: Partial<PluginBundleLimits>;
  /** Defaults to `strict`. */
  profile?: PluginParserProfile;
}
