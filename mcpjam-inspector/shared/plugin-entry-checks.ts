import type { ResolvedPluginExtensionBehavior } from "@mcpjam/sdk/host-config/internal";
import {
  pluginDiagnostic,
  type PluginDiagnostic,
} from "./plugin-diagnostics.js";

/**
 * Which entry points a client lists and opens, from its plugin extension
 * behavior. ChatGPT lists and opens every declared entry point; Claude
 * follows claude.com/docs/connectors/building/mcp-apps/entry-points.
 */
export type EntrypointBehavior = Pick<
  ResolvedPluginExtensionBehavior,
  "entrypointVisibility" | "entrypointNames" | "entrypointQuickActions"
>;

/** ChatGPT's rules, and what a caller that passes no rules gets. */
export const LIST_EVERY_ENTRYPOINT: EntrypointBehavior = Object.freeze({
  entrypointVisibility: "ignore",
  entrypointNames: "any",
  entrypointQuickActions: "show",
});

/** The pairs of characters that keep an entry point from opening, in the
 * order a Logs row names them. */
const DOUBLE_SEPARATORS = ["__", "..", "._", "_."] as const;

export interface EntrypointIssues {
  /** Not listed: the tool declares a visibility without "model". */
  hidden?: "visibility";
  /** Listed, but refused on open: the pairs found in the tool's name. */
  unopenable?: string[];
}

/** Claude's rule read as written: a declared list without "model" hides the
 * tool, an empty list included. A value that isn't a list declares nothing. */
function hiddenFromModel(meta: Record<string, unknown> | undefined): boolean {
  const ui = meta?.ui;
  const visibility =
    ui && typeof ui === "object" && !Array.isArray(ui)
      ? (ui as { visibility?: unknown }).visibility
      : undefined;
  return Array.isArray(visibility) && !visibility.includes("model");
}

export function entrypointIssues(
  tool: { name: string; _meta?: Record<string, unknown> },
  behavior: EntrypointBehavior = LIST_EVERY_ENTRYPOINT,
): EntrypointIssues {
  const issues: EntrypointIssues = {};
  if (
    behavior.entrypointVisibility === "require-model" &&
    hiddenFromModel(tool._meta)
  )
    issues.hidden = "visibility";
  if (behavior.entrypointNames === "no-double-separators") {
    const found = DOUBLE_SEPARATORS.filter((pair) => tool.name.includes(pair));
    if (found.length) issues.unopenable = found;
  }
  return issues;
}

export function quickActionsShown(
  behavior: EntrypointBehavior = LIST_EVERY_ENTRYPOINT,
): boolean {
  return behavior.entrypointQuickActions === "show";
}

/** One Logs row naming the tools whose entry points weren't listed. */
export function hiddenEntrypointDiagnostics(
  names: readonly string[],
  serverId: string,
): PluginDiagnostic[] {
  if (!names.length) return [];
  return [
    {
      ...pluginDiagnostic(
        "warning",
        "PLUGIN_ENTRYPOINT_HIDDEN",
        "Entry points not listed: their tools are hidden from the model",
        'This client lists an entry point only when its tool is visible to the model. Add "model" to each tool\'s _meta.ui.visibility, or remove the entry point if the tool is only for the App.',
        { tools: names.slice(0, 16) },
      ),
      serverId,
    },
  ];
}

/** The Logs title for a refused open, naming the characters it found. */
export function unopenableEntrypointTitle(
  toolName: string,
  pairs: readonly string[],
): string {
  return `Entry point refused: ${toolName} has ${pairs
    .map((pair) => `"${pair}"`)
    .join(" and ")} in its name`;
}
