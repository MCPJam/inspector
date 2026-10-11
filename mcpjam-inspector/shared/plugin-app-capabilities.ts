import {
  bundledHostCompatCatalog,
  getTemplateMcpAppsCapabilities,
} from "@mcpjam/sdk/host-compat";

/** Server-authoritative counterpart of the saved client's App tool switch. */
export function pluginAppToolsEnabled(config: {
  hostStyle: string;
  mcpProfile?: Record<string, unknown>;
}): boolean {
  const apps = config.mcpProfile?.apps;
  if (apps && typeof apps === "object" && !Array.isArray(apps)) {
    const overrides = (apps as Record<string, unknown>).mcpAppsOverrides;
    if (
      overrides &&
      typeof overrides === "object" &&
      !Array.isArray(overrides)
    ) {
      const enabled = (overrides as Record<string, unknown>).serverTools;
      if (typeof enabled === "boolean") return enabled;
      if (enabled !== undefined) return false;
    }
  }
  return (
    getTemplateMcpAppsCapabilities(bundledHostCompatCatalog(), config.hostStyle)
      ?.serverTools === true
  );
}
