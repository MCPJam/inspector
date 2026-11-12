import {
  cloneHostTemplateInput,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";

/** Saved configs have no template baseline: every present value may be deliberate. */
export function addHostTemplateDefaults(
  template: unknown,
  previous: HostConfigInputV2,
): HostConfigInputV2 {
  const latest = cloneHostTemplateInput(template);
  const saved = structuredClone(previous);
  const latestProfile = latest.mcpProfile;
  const savedProfile = saved.mcpProfile;
  const latestApps = latestProfile?.apps;
  const savedApps = savedProfile?.apps;
  const latestExtensions = latestApps?.pluginExtensions;
  const savedExtensions = savedApps?.pluginExtensions;
  const extensions = savedExtensions ?? latestExtensions;
  return {
    ...saved,
    // Capability payloads can use empty objects or arrays as an explicit value.
    // Only the known sparse profile maps below merge their individual keys.
    clientCapabilities: {
      ...latest.clientCapabilities,
      ...saved.clientCapabilities,
    },
    ...(latestProfile || savedProfile
      ? {
          mcpProfile: {
            ...latestProfile,
            ...savedProfile,
            profileVersion: 1,
            ...(latestApps || savedApps
              ? {
                  apps: {
                    ...latestApps,
                    ...savedApps,
                    ...(latestApps?.mcpAppsOverrides ||
                    savedApps?.mcpAppsOverrides
                      ? {
                          mcpAppsOverrides: {
                            ...latestApps?.mcpAppsOverrides,
                            ...savedApps?.mcpAppsOverrides,
                          },
                        }
                      : {}),
                    ...(extensions
                      ? {
                          pluginExtensions: {
                            ...extensions,
                            ...(latestExtensions?.capabilities ||
                            savedExtensions?.capabilities
                              ? {
                                  capabilities: {
                                    ...latestExtensions?.capabilities,
                                    ...savedExtensions?.capabilities,
                                  },
                                }
                              : {}),
                          },
                        }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}
