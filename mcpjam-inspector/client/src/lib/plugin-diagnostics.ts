import { logPluginExtensionIssue } from "@/lib/plugin-extension-logs";
import {
  PLUGIN_DIAGNOSTICS_MAX,
  type PluginDiagnostic,
} from "@/shared/plugin-diagnostics";

export type { PluginDiagnostic } from "@/shared/plugin-diagnostics";
export {
  describePluginError,
  pluginErrorDiagnostic,
} from "@/shared/plugin-diagnostics";

const LEVELS = new Set(["error", "warning", "info"]);
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;

/** Accept only well-formed, bounded diagnostics (server responses are data). */
export function parsePluginDiagnostics(value: unknown): PluginDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const parsed: PluginDiagnostic[] = [];
  for (const item of value.slice(0, PLUGIN_DIAGNOSTICS_MAX)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const level = entry.level;
    const code = text(entry.code, 128);
    const title = text(entry.title, 160);
    const description = text(entry.description, 1000);
    if (!LEVELS.has(level as string) || !code || !title || !description)
      continue;
    parsed.push({
      level: level as PluginDiagnostic["level"],
      code,
      title,
      description,
      ...(text(entry.serverId, 256)
        ? { serverId: text(entry.serverId, 256) }
        : {}),
      ...(entry.details &&
      typeof entry.details === "object" &&
      !Array.isArray(entry.details)
        ? { details: entry.details as Record<string, unknown> }
        : {}),
    });
  }
  return parsed;
}

/**
 * Append plugin diagnostics to the existing Logs panel (right rail) through
 * the shared plugin-extension log helper. No new UI: each diagnostic is one
 * log row (repeats of the same server, code and title update that row); the
 * payload holds the level, code, plain-English description and details.
 */
export function appendPluginDiagnostics(
  diagnostics: unknown,
  fallback: { serverId?: string; serverName?: string } = {},
): PluginDiagnostic[] {
  const parsed = parsePluginDiagnostics(diagnostics);
  for (const diagnostic of parsed) {
    const serverId = diagnostic.serverId ?? fallback.serverId;
    logPluginExtensionIssue({
      code: diagnostic.code,
      level: diagnostic.level,
      message: diagnostic.description,
      ...(serverId ? { serverId } : {}),
      ...(fallback.serverName && !diagnostic.serverId
        ? { serverName: fallback.serverName }
        : {}),
      detail: { title: diagnostic.title, ...(diagnostic.details ?? {}) },
      dedupeKey: `${serverId ?? "plugin"}:${diagnostic.code}:${diagnostic.title}`,
    });
  }
  return parsed;
}
