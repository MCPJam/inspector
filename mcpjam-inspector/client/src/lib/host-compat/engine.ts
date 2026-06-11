import type { ServerWithName } from "@/state/app-types";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import { detectUIType, UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { HOST_COMPAT_PROFILES } from "./profiles";
import type {
  CompatFinding,
  HostCompatProfile,
  HostCompatReport,
  ServerRequirements,
} from "./types";

/**
 * L0 static compatibility engine (prototype).
 *
 * `deriveServerRequirements` reads only data the client already holds:
 * the server config blob (transport, OAuth), `initializationInfo`
 * (advertised capabilities), and an optional tools list (widget usage via
 * `_meta`). `evaluateHostCompat` is a pure join against one host profile.
 * No fetches, no host emulation — verdicts are recomputed on read.
 */

const hasAdvertisedCapability = (
  capabilities: Record<string, unknown>,
  key: string,
): boolean => capabilities[key] != null;

export type CompatDerivationOptions = {
  /** An ngrok tunnel is live, exposing a stdio server over HTTPS. */
  hasActiveTunnel?: boolean;
};

export function deriveServerRequirements(
  server: ServerWithName,
  toolsData?: ListToolsResultWithMetadata | null,
  options?: CompatDerivationOptions,
): ServerRequirements {
  const transport = "url" in server.config ? "http" : "stdio";
  const reachableRemotely =
    transport === "http" || options?.hasActiveTunnel === true;
  const usesOAuth = server.useOAuth === true || server.oauthTokens != null;

  const unknownDimensions: string[] = [];

  const serverCapabilities = server.initializationInfo?.serverCapabilities;
  let capabilities: ServerRequirements["capabilities"];
  if (serverCapabilities) {
    capabilities = {
      prompts: hasAdvertisedCapability(serverCapabilities, "prompts"),
      resources: hasAdvertisedCapability(serverCapabilities, "resources"),
      logging: hasAdvertisedCapability(serverCapabilities, "logging"),
      completions: hasAdvertisedCapability(serverCapabilities, "completions"),
    };
  } else {
    unknownDimensions.push("advertised capabilities (connect to capture)");
  }

  let widgets: ServerRequirements["widgets"];
  if (toolsData?.tools) {
    const mcpAppsOnly: string[] = [];
    const openaiAppsOnly: string[] = [];
    const dual: string[] = [];
    for (const tool of toolsData.tools) {
      const meta =
        toolsData.toolsMetadata?.[tool.name] ??
        (tool._meta as Record<string, unknown> | undefined);
      switch (detectUIType(meta, undefined)) {
        case UIType.MCP_APPS:
          mcpAppsOnly.push(tool.name);
          break;
        case UIType.OPENAI_SDK:
          openaiAppsOnly.push(tool.name);
          break;
        case UIType.OPENAI_SDK_AND_MCP_APPS:
          dual.push(tool.name);
          break;
        default:
          break;
      }
    }
    widgets = { mcpAppsOnly, openaiAppsOnly, dual };
  } else {
    unknownDimensions.push("widget usage (tools metadata not loaded)");
  }

  return {
    transport,
    reachableRemotely,
    usesOAuth,
    protocolVersion: server.initializationInfo?.protocolVersion,
    capabilities,
    widgets,
    unknownDimensions,
  };
}

const formatToolNames = (names: string[]): string => {
  const shown = names.slice(0, 3).map((name) => `\`${name}\``);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
};

export function evaluateHostCompat(
  requirements: ServerRequirements,
  profile: HostCompatProfile,
): HostCompatReport {
  const findings: CompatFinding[] = [];

  // A stdio server with an active tunnel is reachable over HTTPS, so it no
  // longer blocks on remote-only hosts.
  if (
    requirements.transport === "stdio" &&
    !profile.transports.stdio &&
    !requirements.reachableRemotely
  ) {
    findings.push({
      severity: "blocker",
      title: "Local server unreachable",
      detail: `This server runs locally over stdio, but ${profile.label} can only reach servers over the internet.`,
      remediation:
        "Deploy the server behind a public HTTPS endpoint, or create an ngrok tunnel from the server card.",
    });
  }
  if (requirements.transport === "http" && !profile.transports.remoteHttp) {
    findings.push({
      severity: "blocker",
      title: "Remote servers unsupported",
      detail: `${profile.label} cannot connect to remote HTTP servers.`,
    });
  }

  if (requirements.usesOAuth && !profile.oauth) {
    findings.push({
      severity: "blocker",
      title: "OAuth flow unsupported",
      detail: `This server requires OAuth, which ${profile.label} cannot complete.`,
    });
  }

  if (requirements.capabilities) {
    const caps = requirements.capabilities;
    if (caps.prompts && !profile.serverCapabilities.prompts) {
      findings.push({
        severity: "degraded",
        title: "Prompts won't appear",
        detail: `The server advertises MCP prompts, but ${profile.label} doesn't surface them to users.`,
      });
    }
    if (caps.resources && !profile.serverCapabilities.resources) {
      findings.push({
        severity: "degraded",
        title: "Resources won't be browsable",
        detail: `The server advertises MCP resources, but ${profile.label} doesn't expose them.`,
      });
    }
    if (caps.logging && !profile.serverCapabilities.logging) {
      findings.push({
        severity: "info",
        title: "Log messages dropped",
        detail: `${profile.label} doesn't surface MCP log messages.`,
      });
    }
    if (caps.completions && !profile.serverCapabilities.completions) {
      findings.push({
        severity: "info",
        title: "Argument autocomplete unavailable",
        detail: `${profile.label} doesn't request completions.`,
      });
    }
  }

  if (requirements.widgets) {
    const { mcpAppsOnly, openaiAppsOnly, dual } = requirements.widgets;
    // Dual-bridge tools render anywhere either bridge exists; they only
    // degrade when the host has no widget surface at all.
    const unrenderable: string[] = [
      ...(profile.apps.mcpApps ? [] : mcpAppsOnly),
      ...(profile.apps.openaiApps ? [] : openaiAppsOnly),
      ...(profile.apps.mcpApps || profile.apps.openaiApps ? [] : dual),
    ];
    if (unrenderable.length > 0) {
      const count = unrenderable.length;
      findings.push({
        severity: "degraded",
        title: `${count} widget${count === 1 ? "" : "s"} fall back to text`,
        detail: `${formatToolNames(unrenderable)} declare${count === 1 ? "s" : ""} a UI that ${profile.label} won't render — users get the plain-text result instead.`,
        remediation:
          profile.apps.mcpApps && !profile.apps.openaiApps
            ? "Declare an MCP Apps template (`_meta.ui.resourceUri`) alongside the OpenAI one."
            : !profile.apps.mcpApps && profile.apps.openaiApps
              ? "Declare an OpenAI Apps template (`openai/outputTemplate`) alongside the MCP Apps one."
              : undefined,
      });
    }
  }

  const hasBlocker = findings.some((f) => f.severity === "blocker");
  const hasDegraded = findings.some((f) => f.severity === "degraded");
  const verdict = hasBlocker
    ? "blocked"
    : hasDegraded
      ? "degraded"
      : requirements.unknownDimensions.length > 0
        ? "unknown"
        : "works";

  return {
    hostId: profile.id,
    hostLabel: profile.label,
    logoSrc: profile.logoSrc,
    verdict,
    provenance: profile.provenance,
    findings,
  };
}

export type HostCompatEvaluation = {
  requirements: ServerRequirements;
  reports: HostCompatReport[];
};

export function evaluateAllHosts(
  server: ServerWithName,
  toolsData?: ListToolsResultWithMetadata | null,
  options?: CompatDerivationOptions,
): HostCompatEvaluation {
  const requirements = deriveServerRequirements(server, toolsData, options);
  return {
    requirements,
    reports: HOST_COMPAT_PROFILES.map((profile) =>
      evaluateHostCompat(requirements, profile),
    ),
  };
}
