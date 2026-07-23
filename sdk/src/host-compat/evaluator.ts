import {
  deriveServerRequirements,
  type HostCompatToolsInput,
} from "./server-requirements.js";
import type { WidgetCapabilityNeed, WidgetUsage } from "./widget-scan.js";
import type {
  CompatFinding,
  CompatLane,
  CompatLaneVerdict,
  CompatProvenance,
  CompatVerdict,
  ConnectionFacts,
  HostCompatProfile,
  HostCompatReport,
  ServerRequirements,
} from "./types.js";

/**
 * Static host-compatibility evaluator. Joins a server's derived requirements
 * against per-host capability profiles to produce works/degraded/blocked
 * verdicts. Two lanes:
 *  - **apps**: render failures + capability gaps the server's widgets actually
 *    hit (L1 scan).
 *  - **server**: protocol-version compatibility from `connectionFacts`.
 *
 * Top-level verdict is the worst of the two lanes; each finding + lane carries
 * its own provenance so a Tier-2 `observed` fact never makes the whole report
 * read as observed.
 *
 * Pure: `evaluateAllHosts` takes the host profiles as input — the SDK does not
 * assume a particular host catalog, so the inspector, CLI, and API can all
 * supply their own.
 */

const formatToolNames = (names: string[]): string => {
  const shown = names.slice(0, 3).map((name) => `\`${name}\``);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
};

const SANDBOX_PERMISSION_LABELS: Record<string, string> = {
  camera: "Camera",
  microphone: "Microphone",
  geolocation: "Location",
  clipboardWrite: "Clipboard",
};

const sandboxPermissionLabel = (name: string): string =>
  `${SANDBOX_PERMISSION_LABELS[name] ?? name} access`;

const sandboxPermissionSentenceLabel = (name: string): string => {
  const label = sandboxPermissionLabel(name);
  return `${label.slice(0, 1).toLowerCase()}${label.slice(1)}`;
};

const joinPermissionLabels = (names: string[]): string => {
  const labels = names.map(sandboxPermissionSentenceLabel);
  if (labels.length <= 1) return labels[0] ?? "sandbox access";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
};

function unsupportedSandboxPermissionNames(
  requirements: ServerRequirements,
  profile: HostCompatProfile
): string[] | undefined {
  const requested = requirements.widgetUsage?.sandboxPermissionNames;
  if (!requested?.length) return undefined;

  // An explicit capability=false is authoritative, even if a stale or
  // inconsistent allowlist happens to contain a permission.
  if (profile.capabilities?.sandboxPermissions === false) {
    return requested;
  }

  // An allowlist is exact. In particular, {} means no permissions are
  // supported; it is not equivalent to missing catalog data.
  if (profile.sandboxPermissionAllow) {
    return requested.filter(
      (permission) => profile.sandboxPermissionAllow?.[permission] !== true
    );
  }

  return undefined;
}

/**
 * Per-capability finding copy, keyed by the same dimensions the L1 scan
 * detects. A finding fires only when (a) the widget needs the capability and
 * (b) the host's matrix lacks positive confirmation. Explicit `false` profile
 * values are reported as unsupported; missing values remain not verified.
 */
const CAPABILITY_CHECKS: ReadonlyArray<{
  key: WidgetCapabilityNeed;
  severity: CompatFinding["severity"];
  subject: string;
  request: string;
  unsupportedObject: string;
}> = [
  {
    key: "serverTools",
    severity: "degraded",
    subject: "Interactive tool calls",
    request: "uses interactive tool calls",
    unsupportedObject: "them",
  },
  {
    key: "serverResources",
    severity: "degraded",
    subject: "Resource reads",
    request: "reads additional resources",
    unsupportedObject: "resource reads",
  },
  {
    key: "message",
    severity: "degraded",
    subject: "Follow-up messages",
    request: "sends follow-up messages",
    unsupportedObject: "them",
  },
  {
    key: "updateModelContext",
    severity: "degraded",
    subject: "Model context updates",
    request: "updates the model context",
    unsupportedObject: "model context updates",
  },
  {
    key: "openLinks",
    severity: "degraded",
    subject: "External links",
    request: "opens external links",
    unsupportedObject: "them",
  },
  {
    key: "downloadFile",
    severity: "degraded",
    subject: "File downloads",
    request: "downloads files",
    unsupportedObject: "file downloads",
  },
  {
    key: "sandboxPermissions",
    severity: "degraded",
    subject: "Widget sandbox permissions",
    request: "uses sandbox permissions",
    unsupportedObject: "them",
  },
  {
    key: "cspFrameDomains",
    severity: "degraded",
    subject: "Embedded content",
    request: "loads nested iframes",
    unsupportedObject: "nested iframes",
  },
  {
    key: "logging",
    severity: "info",
    subject: "Widget logs",
    request: "sends logs",
    unsupportedObject: "them",
  },
];

/** Worst-wins ordering for verdict aggregation across lanes. */
const VERDICT_RANK: Record<CompatVerdict, number> = {
  works: 0,
  unknown: 1,
  degraded: 2,
  blocked: 3,
};

/** Trust ordering — `observed` (live) strongest, `assumed` weakest. */
const PROVENANCE_RANK: Record<CompatProvenance, number> = {
  assumed: 0,
  probe: 1,
  "vendor-doc": 2,
  observed: 3,
};

/** Weakest provenance among a lane's findings, falling back to the host baseline. */
function weakestProvenance(
  findings: CompatFinding[],
  fallback: CompatProvenance
): CompatProvenance {
  return findings.reduce<CompatProvenance>(
    (weak, f) =>
      PROVENANCE_RANK[f.provenance] < PROVENANCE_RANK[weak]
        ? f.provenance
        : weak,
    fallback
  );
}

/**
 * Roll a lane's findings into a verdict. `degraded` outranks `unknown` (a real
 * functional loss beats an unanalyzed dimension); `unknown` only when the lane
 * has an undetermined dimension and no harder finding.
 */
function laneVerdict(
  findings: CompatFinding[],
  lane: CompatLane,
  unknown: boolean,
  baseProvenance: CompatProvenance
): CompatLaneVerdict {
  const laneFindings = findings.filter((f) => f.lane === lane);
  const hasBlocker = laneFindings.some((f) => f.severity === "blocker");
  const hasDegraded = laneFindings.some((f) => f.severity === "degraded");
  const verdict: CompatVerdict = hasBlocker
    ? "blocked"
    : hasDegraded
    ? "degraded"
    : unknown
    ? "unknown"
    : "works";
  return {
    verdict,
    provenance: weakestProvenance(laneFindings, baseProvenance),
  };
}

export function evaluateHostCompat(
  requirements: ServerRequirements,
  profile: HostCompatProfile
): HostCompatReport {
  const findings: CompatFinding[] = [];

  if (requirements.hasWidgets) {
    // 1. Render failures: widgets whose bridge this host can't render.
    const unrenderable = [
      ...(profile.rendersMcpApps ? [] : requirements.widgets.mcpAppsOnly),
      ...(profile.rendersOpenAiApps ? [] : requirements.widgets.openaiAppsOnly),
      ...(profile.rendersMcpApps || profile.rendersOpenAiApps
        ? []
        : requirements.widgets.dual),
    ];

    const remediation =
      profile.rendersMcpApps && !profile.rendersOpenAiApps
        ? "Declare an MCP Apps template (`_meta.ui.resourceUri`) alongside the OpenAI one."
        : !profile.rendersMcpApps && profile.rendersOpenAiApps
        ? "Declare an OpenAI Apps template (`openai/outputTemplate`) alongside the MCP Apps one."
        : undefined; // host renders neither (CLI) — nothing to declare.

    // App-only widgets have no text fallback: unrenderable = unusable tool.
    const blockedAppOnly = unrenderable.filter((name) =>
      requirements.appOnlyWidgets.includes(name)
    );
    const degradedFallback = unrenderable.filter(
      (name) => !requirements.appOnlyWidgets.includes(name)
    );

    if (blockedAppOnly.length > 0) {
      const count = blockedAppOnly.length;
      findings.push({
        lane: "apps",
        severity: "blocker",
        code: "app_only_unrenderable",
        tools: blockedAppOnly,
        title: `${
          count === 1 ? "Interactive tool" : `${count} interactive tools`
        } unavailable`,
        detail: `${formatToolNames(blockedAppOnly)} only ${
          count === 1 ? "works" : "work"
        } inside a widget. ${profile.label} does not render ${
          count === 1 ? "it" : "them"
        }.`,
        remediation,
        provenance: profile.provenance,
      });
    }
    if (degradedFallback.length > 0) {
      const count = degradedFallback.length;
      findings.push({
        lane: "apps",
        severity: "degraded",
        code: "widget_text_fallback",
        tools: degradedFallback,
        title: `${
          count === 1 ? "Interactive view" : `${count} interactive views`
        } unavailable`,
        detail: `${formatToolNames(degradedFallback)} provide${
          count === 1 ? "s" : ""
        } an interactive view. ${
          profile.label
        } shows the plain-text result instead.`,
        remediation,
        provenance: profile.provenance,
      });
    }

    // 2. Capability gaps — SERVER-SPECIFIC: only for widgets that actually use
    //    a capability (from the L1 scan) the host lacks.
    if (profile.capabilities && requirements.widgetUsage) {
      for (const check of CAPABILITY_CHECKS) {
        const permissionNames =
          check.key === "sandboxPermissions"
            ? requirements.widgetUsage.sandboxPermissionNames
            : undefined;
        const unsupportedPermissions =
          check.key === "sandboxPermissions"
            ? unsupportedSandboxPermissionNames(requirements, profile)
            : undefined;
        const hasExactSandboxResult =
          check.key === "sandboxPermissions" &&
          permissionNames !== undefined &&
          (unsupportedPermissions !== undefined ||
            profile.capabilities[check.key] === false);
        const unsupported = hasExactSandboxResult
          ? (unsupportedPermissions?.length ?? 0) > 0
          : profile.capabilities[check.key] !== true;
        const tools =
          check.key === "sandboxPermissions" &&
          unsupportedPermissions !== undefined &&
          requirements.widgetUsage.sandboxPermissionTools
            ? Array.from(
                new Set(
                  unsupportedPermissions.flatMap(
                    (permission) =>
                      requirements.widgetUsage?.sandboxPermissionTools?.[
                        permission
                      ] ?? []
                  )
                )
              )
            : requirements.widgetUsage[check.key];
        if (tools && tools.length > 0 && unsupported) {
          const explicitlyUnsupported =
            hasExactSandboxResult || profile.capabilities[check.key] === false;
          const supportLabel = explicitlyUnsupported
            ? "unsupported"
            : "not verified";
          const sandboxPermissionCopy =
            check.key === "sandboxPermissions" && unsupportedPermissions?.length
              ? {
                  title:
                    unsupportedPermissions.length === 1
                      ? `${sandboxPermissionLabel(
                          unsupportedPermissions[0]
                        )} unavailable`
                      : "Widget sandbox permissions unsupported",
                  detail:
                    unsupportedPermissions.length === 1
                      ? `This widget requests ${sandboxPermissionSentenceLabel(
                          unsupportedPermissions[0]
                        )}. ${profile.label} does not support it.`
                      : `This widget requests ${joinPermissionLabels(
                          unsupportedPermissions
                        )}. ${profile.label} does not support them.`,
                }
              : undefined;
          findings.push({
            lane: "apps",
            severity: check.severity,
            code: "capability_unsupported",
            capability: check.key,
            // Copy: `tools` is the shared `widgetUsage[key]` array — don't let a
            // finding alias (and let a surface mutate) the requirements object.
            tools: [...tools],
            title:
              sandboxPermissionCopy?.title ??
              `${check.subject} ${
                supportLabel === "unsupported" ? "unavailable" : "not confirmed"
              }`,
            detail:
              sandboxPermissionCopy?.detail ??
              (supportLabel === "unsupported"
                ? `This widget ${check.request}. ${profile.label} does not support ${check.unsupportedObject}.`
                : `This widget ${check.request}. Support is not confirmed for ${profile.label}.`),
            provenance: profile.provenance,
          });
        }
      }
    }
  }

  // 3. Server lane — protocol-version compatibility. `info`, not `degraded`:
  //    we only sampled ONE version the server negotiated with us; the host may
  //    still negotiate a shared version. Surfaced, never alarmist.
  const serverVersion = requirements.connectionFacts?.protocolVersion;
  const hostVersions = profile.supportedProtocolVersions;
  if (
    serverVersion &&
    hostVersions &&
    hostVersions.length > 0 &&
    !hostVersions.includes(serverVersion)
  ) {
    findings.push({
      lane: "server",
      severity: "info",
      code: "protocol_version_mismatch",
      title: "Protocol version differs",
      detail: `This server uses MCP \`${serverVersion}\`. ${
        profile.label
      } supports ${hostVersions
        .map((v) => `\`${v}\``)
        .join(
          ", "
        )}. The connection works only if both support a shared version.`,
      remediation: `Check that the server supports ${
        hostVersions.length === 1 ? "this version" : "one of these versions"
      }.`,
      provenance: profile.provenance,
    });
  }

  const apps = laneVerdict(
    findings,
    "apps",
    requirements.unknownDimensions.length > 0,
    profile.provenance
  );
  // A server-lane finding (today: a protocol-version difference) means we can't
  // confirm the host will accept this server — it MAY negotiate a shared
  // version, but we only sampled one. Surface that as "unknown" rather than a
  // confident green "works"; the finding itself stays `info` (non-alarmist).
  const serverHasFinding = findings.some((f) => f.lane === "server");
  const server = laneVerdict(
    findings,
    "server",
    serverHasFinding,
    profile.provenance
  );
  const verdict =
    VERDICT_RANK[apps.verdict] >= VERDICT_RANK[server.verdict]
      ? apps.verdict
      : server.verdict;

  return {
    hostId: profile.id,
    hostLabel: profile.label,
    verifiedAt: profile.verifiedAt,
    verdict,
    provenance: profile.provenance,
    lanes: { apps, server },
    findings,
  };
}

export type HostCompatEvaluation = {
  requirements: ServerRequirements;
  reports: HostCompatReport[];
};

/** Optional inputs that aren't the tools list. */
export interface EvaluateAllHostsOptions {
  widgetUsage?: WidgetUsage;
  connectionFacts?: ConnectionFacts;
  /**
   * The tools list may be incomplete (e.g. pagination was capped before the
   * server ran out of tools). When true, a confident `works` can't be
   * justified — a later, unseen tool could declare a widget that breaks a host
   * — so every host that would read `works` is demoted to `unknown`, and an
   * unknown dimension records why.
   */
  toolsTruncated?: boolean;
}

/**
 * Evaluate a server against a set of host profiles. The caller supplies the
 * profiles (the SDK ships the engine, not a fixed host catalog — a market-host
 * catalog comes in a follow-up so CLI/API/UI can share one).
 */
export function evaluateAllHosts(
  toolsData: HostCompatToolsInput | null | undefined,
  profiles: HostCompatProfile[],
  options?: EvaluateAllHostsOptions
): HostCompatEvaluation {
  const requirements = deriveServerRequirements(
    toolsData,
    options?.widgetUsage,
    options?.connectionFacts
  );
  if (options?.toolsTruncated) {
    requirements.unknownDimensions.push(
      "tool list incomplete — pagination truncated, later tools/widgets not evaluated"
    );
  }
  return {
    requirements,
    reports: profiles.map((profile) => {
      const report = evaluateHostCompat(requirements, profile);
      // Incomplete tool list → can't justify "works"; demote to unknown
      // (apps lane + aggregate). Negative verdicts stand — a missing tool
      // can't make a degraded/blocked host suddenly work.
      if (!options?.toolsTruncated || report.verdict !== "works") return report;
      return {
        ...report,
        verdict: "unknown" as const,
        lanes: {
          ...report.lanes,
          apps: { ...report.lanes.apps, verdict: "unknown" as const },
        },
      };
    }),
  };
}
