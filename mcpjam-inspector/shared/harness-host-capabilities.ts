import { resolveOpenAiCompatForHostConfig } from "@mcpjam/sdk/host-config/internal";
import { resolveBuiltInHostCapabilities } from "./host-style-capabilities";

export type HarnessHostCapabilityQualification = {
  capabilities: Record<string, unknown>;
  gaps: string[];
};

type HostCapability =
  | "openLinks"
  | "downloadFile"
  | "serverTools"
  | "serverResources"
  | "logging"
  | "message"
  | "updateModelContext";

/** Callbacks installed by the hosted widget renderer and its owned App bridge. */
export const HOSTED_APP_HANDLERS: Readonly<Record<HostCapability, boolean>> = {
  openLinks: true,
  downloadFile: true,
  serverTools: true,
  serverResources: true,
  logging: true,
  message: true,
  updateModelContext: true,
};

// The common fallback forwards text. Richer owned callbacks need their own
// qualification before a profile declaring them can migrate.
const CONTENT_FORMATS = new Set(["text"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Qualify the effective declaration; never remove an unsupported claim. */
export function qualifyHarnessHostCapabilities(
  host: {
    hostStyle?: unknown;
    mcpProfile?: unknown;
    hostCapabilitiesOverride?: unknown;
  },
  handlers: Partial<Record<HostCapability, boolean>>,
): HarnessHostCapabilityQualification {
  const gaps: string[] = [];
  let capabilities: Record<string, unknown>;
  try {
    if (host.mcpProfile !== undefined && !isRecord(host.mcpProfile)) {
      return { capabilities: {}, gaps: ["invalid-host-profile"] };
    }
    const apps = host.mcpProfile?.apps;
    const matrix = isRecord(apps) ? apps.mcpAppsOverrides : undefined;
    if (resolveOpenAiCompatForHostConfig(host))
      gaps.push("host-compatibility:openai-apps");
    if (matrix !== undefined && !isRecord(matrix)) {
      return { capabilities: {}, gaps: ["invalid-host-capabilities"] };
    }
    const legacy =
      matrix !== undefined ? undefined : host.hostCapabilitiesOverride;
    if (legacy !== undefined && !isRecord(legacy)) {
      return { capabilities: {}, gaps: ["invalid-host-capabilities"] };
    }
    capabilities = {
      ...resolveBuiltInHostCapabilities({
        hostStyle:
          typeof host.hostStyle === "string" ? host.hostStyle : undefined,
        profile: host.mcpProfile as Parameters<
          typeof resolveBuiltInHostCapabilities
        >[0]["profile"],
        hostCapabilitiesOverride: legacy,
      }),
    };
  } catch {
    return { capabilities: {}, gaps: ["invalid-host-capabilities"] };
  }

  for (const [name, value] of Object.entries(capabilities)) {
    if (
      name === "experimental" &&
      isRecord(value) &&
      Object.keys(value).length === 0
    )
      continue;
    if (!Object.hasOwn(HOSTED_APP_HANDLERS, name)) {
      gaps.push(`host-capability:${name}`);
      continue;
    }
    if (handlers[name as HostCapability] !== true)
      gaps.push(`host-handler:${name}`);
    if (!isRecord(value)) {
      gaps.push(`host-capability:${name}`);
      continue;
    }
    for (const [option, setting] of Object.entries(value)) {
      if (name === "message" || name === "updateModelContext") {
        if (
          (CONTENT_FORMATS.has(option) ||
            (name === "updateModelContext" &&
              option === "structuredContent")) &&
          isRecord(setting) &&
          Object.keys(setting).length === 0
        )
          continue;
      } else if (
        (name === "serverTools" || name === "serverResources") &&
        option === "listChanged" &&
        setting === false
      )
        continue;
      gaps.push(`host-capability:${name}.${option}`);
    }
  }
  return { capabilities, gaps };
}
