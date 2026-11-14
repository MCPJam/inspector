/**
 * Where the plugin is inside a package (the directory `${PLUGIN_ROOT}` names)
 * and its manifest: the one answer the import parser and the ChatGPT readiness
 * reader both use, so a package cannot import and then grade as having none.
 *
 * Paths only, so it runs before any content is read. A manifest at the archive
 * root wins, at the first of the profile's locations. Under
 * `openai-compatible` the plugin may instead sit in one top-level directory,
 * as the ChatGPT portal allows, when no other directory holds a manifest and
 * nothing lies beside it. `strict` reads a root `plugin.json` only.
 */

import { LEGACY_MANIFEST_LOCATIONS } from "./layout.js";
import { PLUGIN_MANIFEST_PATH } from "./manifest.js";
import {
  PLUGIN_PORTAL_RULES,
  type PluginPortalRuleCode,
} from "./portal-rules.js";
import type { PluginBundleLayout, PluginParserProfile } from "./types.js";
import type { PluginIssueCode, PluginIssueCollector } from "./validation.js";

export interface PluginManifestLocation {
  /** Relative to the plugin root. */
  path: string;
  layout: PluginBundleLayout;
}

export type PluginRootRuleCode = Extract<
  PluginPortalRuleCode,
  | "plugin_manifest_missing"
  | "plugin_root_ambiguous"
  | "plugin_root_has_siblings"
>;

export interface PluginRootRefusal {
  code: PluginRootRuleCode;
  /** The top-level entry it names: a directory with a manifest, or a sibling. */
  path?: string;
}

export interface PluginRoot {
  /** `""` for the archive root, else the top-level directory the plugin is in. */
  directory: string;
  /** Absent when no single manifest was found. */
  manifest?: PluginManifestLocation;
  /** The portal's rules the package breaks; any one refuses it. */
  refusals: PluginRootRefusal[];
}

/** Every manifest location, in precedence order. */
const MANIFEST_LOCATIONS: readonly PluginManifestLocation[] = [
  { path: PLUGIN_MANIFEST_PATH, layout: "agent-plugins" },
  ...LEGACY_MANIFEST_LOCATIONS,
];

function manifestIn(
  directory: string,
  filePaths: ReadonlySet<string>,
  profile: PluginParserProfile
): PluginManifestLocation | undefined {
  const prefix = directory === "" ? "" : `${directory}/`;
  return MANIFEST_LOCATIONS.find(
    ({ path, layout }) =>
      (profile === "openai-compatible" || layout === "agent-plugins") &&
      filePaths.has(`${prefix}${path}`)
  );
}

/** Find the plugin root among a package's file paths (directories excluded). */
export function findPluginRoot(
  filePaths: ReadonlySet<string>,
  profile: PluginParserProfile
): PluginRoot {
  const atRoot = manifestIn("", filePaths, profile);
  if (atRoot !== undefined) {
    return { directory: "", manifest: atRoot, refusals: [] };
  }
  const topLevel = [
    ...new Set([...filePaths].map((path) => path.split("/", 1)[0])),
  ].sort();
  const holders =
    profile === "strict"
      ? []
      : topLevel.filter((name) => manifestIn(name, filePaths, profile));
  if (holders.length !== 1) {
    return {
      directory: "",
      refusals:
        holders.length === 0
          ? [{ code: "plugin_manifest_missing" }]
          : holders.map((path) => ({ code: "plugin_root_ambiguous", path })),
    };
  }
  const [directory] = holders;
  return {
    directory,
    manifest: manifestIn(directory, filePaths, profile),
    refusals: topLevel
      .filter((name) => name !== directory)
      .map((path) => ({ code: "plugin_root_has_siblings", path })),
  };
}

/** `path` relative to the plugin root `directory`, or `undefined` outside it. */
export function pathInPluginRoot(
  directory: string,
  path: string
): string | undefined {
  if (directory === "") return path;
  return path.startsWith(`${directory}/`)
    ? path.slice(directory.length + 1)
    : undefined;
}

const ROOT_ISSUE_CODES: Record<PluginRootRuleCode, PluginIssueCode> = {
  plugin_manifest_missing: "MANIFEST_MISSING",
  plugin_root_ambiguous: "PLUGIN_ROOT_AMBIGUOUS",
  plugin_root_has_siblings: "PLUGIN_ROOT_HAS_SIBLINGS",
};

/** Report each refusal as a parse error, in the portal's words. */
export function reportPluginRootRefusals(
  root: PluginRoot,
  profile: PluginParserProfile,
  issues: PluginIssueCollector
): void {
  for (const { code, path } of root.refusals) {
    // `strict` never looks past the root, so its only refusal is a missing
    // `plugin.json`, and the portal's message names locations it never reads.
    const message =
      profile === "strict"
        ? `bundle is missing "${PLUGIN_MANIFEST_PATH}" at its root`
        : PLUGIN_PORTAL_RULES[code].message;
    issues.error(ROOT_ISSUE_CODES[code], message, path ? { path } : undefined);
  }
}
