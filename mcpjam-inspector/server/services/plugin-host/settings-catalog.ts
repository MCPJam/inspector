import { Validator, type Schema } from "@cfworker/json-schema";
import {
  pluginSettingsCapability,
  PluginSettingsError,
  type PluginSettingsDocument,
} from "../../../shared/plugin-settings.js";
import { pluginEntrypointTitle } from "../../../shared/plugin-activation.js";
import type { createPluginRequestRuntime } from "./request-runtime.js";
import { pluginBindingDigest } from "./bindings.js";
import { DialectAwareJsonSchemaValidator } from "@mcpjam/sdk";
import { mcpAppToolResultSchema as CallToolResultSchema } from "@mcpjam/sdk/widget-runtime";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import { pluginToolCallValidation } from "./tool-call-validation.js";
import {
  pluginDiagnostic,
  type PluginDiagnostic,
} from "../../../shared/plugin-diagnostics.js";

export type PluginSettingsCatalog = Pick<
  Awaited<ReturnType<ReturnType<typeof createPluginRequestRuntime>["catalog"]>>,
  | "tools"
  | "serverCapabilities"
  | "transport"
  | "hostRevision"
  | "bindingId"
  | "serverIdentity"
  | "protocolVersion"
>;
type Catalog = PluginSettingsCatalog;

export interface PluginSettingsActionBinding {
  name: string;
  kind: "tool" | "app" | "unavailable";
  revision: string;
}

export function settingsActionRevision(
  catalog: Catalog,
  tool: Catalog["tools"][number],
) {
  return pluginBindingDigest([
    resolvePluginSettingsCatalog(catalog)?.revision,
    tool,
  ]);
}

/** Layout gives same-server names, never arbitrary arguments or an execution grant. */
export function settingsActionBindings(
  document: PluginSettingsDocument,
  catalog: Catalog,
): PluginSettingsActionBinding[] {
  const names = new Set(
    document.groups.flatMap((group) =>
      group.items.flatMap((item) => (item.kind === "tool" ? [item.tool] : [])),
    ),
  );
  return [...names].map((name) => {
    const tool = catalog.tools.find((tool) => tool.name === name);
    if (!tool) return { name, kind: "unavailable", revision: "" };
    const revision = settingsActionRevision(catalog, tool);
    try {
      settingsActionToolValidation(tool);
      const uri =
        getToolUiResourceUri({ _meta: tool._meta }) ??
        tool._meta?.["openai/outputTemplate"];
      if (
        uri !== undefined &&
        (typeof uri !== "string" || !uri.startsWith("ui://"))
      )
        throw new PluginSettingsError("PLUGIN_SETTINGS_ACTION_UI_INVALID");
      return { name, kind: uri ? "app" : "tool", revision };
    } catch {
      return { name, kind: "unavailable", revision };
    }
  });
}

/** Optional output schemas remain authoritative for ordinary action tools. */
export function settingsActionToolValidation(tool: Catalog["tools"][number]) {
  return pluginToolCallValidation(
    tool,
    {},
    (kind) =>
      new PluginSettingsError(
        {
          arguments: "PLUGIN_SETTINGS_ACTION_ARGUMENTS_INVALID",
          schema: "PLUGIN_SETTINGS_TOOL_SCHEMA_INVALID",
          limit: "PLUGIN_SETTINGS_LIMIT",
          result: "PLUGIN_SETTINGS_INVALID_RESULT",
        }[kind],
      ),
  );
}

/** Never depend on the manager's best-effort first-page output schema lookup. */
export function settingsToolValidation(
  tool: Catalog["tools"][number],
  args: Record<string, unknown>,
) {
  const validator = new DialectAwareJsonSchemaValidator();
  try {
    const input = validator.getValidator(
      tool.inputSchema as Parameters<typeof validator.getValidator>[0],
    );
    const output = validator.getValidator(
      tool.outputSchema as Parameters<typeof validator.getValidator>[0],
    );
    if (!input(args).valid)
      throw new PluginSettingsError("PLUGIN_SETTINGS_ARGUMENTS_INVALID");
    return (result: unknown) => {
      if (
        new TextEncoder().encode(JSON.stringify(result)).byteLength >
        512 * 1024
      )
        throw new PluginSettingsError("PLUGIN_SETTINGS_LIMIT");
      const parsed = CallToolResultSchema.safeParse(result);
      if (
        !parsed.success ||
        parsed.data.isError ||
        !parsed.data.structuredContent ||
        !output(parsed.data.structuredContent).valid
      )
        throw new PluginSettingsError("PLUGIN_SETTINGS_INVALID_RESULT");
    };
  } catch (error) {
    if (error instanceof PluginSettingsError) throw error;
    throw new PluginSettingsError("PLUGIN_SETTINGS_TOOL_SCHEMA_INVALID");
  }
}

/** Discovery does not invoke tools or mint an execution grant. */
export function discoverPluginSettings(catalog: Catalog) {
  return resolvePluginSettingsCatalog(catalog)?.settings;
}

export function resolvePluginSettingsCatalog(catalog: Catalog) {
  const capability = pluginSettingsCapability(
    catalog.serverCapabilities,
    catalog.transport,
  );
  if (!capability) return undefined;
  const read = catalog.tools.find(({ name }) => name === capability.readTool);
  const update = catalog.tools.find(
    ({ name }) => name === capability.updateTool,
  );
  if (!read || !update)
    throw new PluginSettingsError("PLUGIN_SETTINGS_TOOL_UNAVAILABLE");
  if (!read.outputSchema || !update.outputSchema)
    throw new PluginSettingsError("PLUGIN_SETTINGS_OUTPUT_SCHEMA_REQUIRED");
  try {
    if (!new Validator(read.inputSchema as Schema).validate({}).valid)
      throw new PluginSettingsError("PLUGIN_SETTINGS_READ_ARGUMENTS_INVALID");
  } catch (error) {
    if (error instanceof PluginSettingsError) throw error;
    throw new PluginSettingsError("PLUGIN_SETTINGS_READ_ARGUMENTS_INVALID");
  }
  const settings = { ...capability, title: pluginEntrypointTitle(read) };
  // The spec requires a read-only read tool. Warn; never refuse settings.
  const diagnostics: PluginDiagnostic[] =
    (read as { annotations?: { readOnlyHint?: unknown } }).annotations
      ?.readOnlyHint === true
      ? []
      : [
          pluginDiagnostic(
            "warning",
            "PLUGIN_SETTINGS_READ_NOT_READ_ONLY",
            `Settings read tool "${read.name}" isn't marked read-only`,
            `The settings read tool must be read-only. Add annotations.readOnlyHint: true to "${read.name}" so clients can call it without asking for approval.`,
            { tool: read.name },
          ),
        ];
  return {
    settings,
    diagnostics,
    read,
    update,
    revision: pluginBindingDigest([
      catalog.hostRevision,
      catalog.bindingId,
      catalog.serverIdentity,
      catalog.protocolVersion,
      settings,
      read,
      update,
    ]),
  };
}
