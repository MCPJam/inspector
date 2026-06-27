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

/**
 * Per-capability finding copy, keyed by the same dimensions the L1 scan
 * detects. A finding fires only when (a) the widget needs the capability and
 * (b) the host's matrix lacks it. `degraded` for real functional loss, `info`
 * for cosmetic.
 */
const CAPABILITY_CHECKS: ReadonlyArray<{
  key: WidgetCapabilityNeed;
  severity: CompatFinding["severity"];
  title: string;
  api: string;
  consequence: string;
}> = [
  { key: "serverTools", severity: "degraded", title: "Server tool calls won't work", api: "tools/call", consequence: "its interactive actions won't reach the server" },
  { key: "serverResources", severity: "degraded", title: "Resource reads won't work", api: "resources/read", consequence: "it won't get the MCP resources it fetches" },
  { key: "message", severity: "degraded", title: "Follow-up messages won't work", api: "ui/message", consequence: "it can't send follow-up chat messages" },
  { key: "updateModelContext", severity: "degraded", title: "Model-context updates won't work", api: "ui/update-model-context", consequence: "it can't push state into the model's context" },
  { key: "openLinks", severity: "degraded", title: "Links won't open", api: "ui/open-link", consequence: "its external links won't open" },
  { key: "downloadFile", severity: "degraded", title: "Downloads won't work", api: "ui/download-file", consequence: "its export/download won't work" },
  { key: "sandboxPermissions", severity: "degraded", title: "Device permissions denied", api: "sandbox permissions", consequence: "the camera/mic/geo/clipboard access it requests won't be granted" },
  { key: "cspFrameDomains", severity: "degraded", title: "Nested iframes blocked", api: "csp.frameDomains", consequence: "the nested iframes it declares won't load" },
  { key: "logging", severity: "info", title: "Widget logs dropped", api: "notifications/message", consequence: "its log messages won't surface" },
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
  fallback: CompatProvenance,
): CompatProvenance {
  return findings.reduce<CompatProvenance>(
    (weak, f) =>
      PROVENANCE_RANK[f.provenance] < PROVENANCE_RANK[weak] ? f.provenance : weak,
    fallback,
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
  baseProvenance: CompatProvenance,
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
  return { verdict, provenance: weakestProvenance(laneFindings, baseProvenance) };
}

export function evaluateHostCompat(
  requirements: ServerRequirements,
  profile: HostCompatProfile,
): HostCompatReport {
  const findings: CompatFinding[] = [];

  if (requirements.hasWidgets) {
    // 1. Render failures: widgets whose bridge this host can't render.
    const unrenderable = [
      ...(profile.rendersMcpApps ? [] : requirements.widgets.mcpAppsOnly),
      ...(profile.rendersOpenAiApps
        ? []
        : requirements.widgets.openaiAppsOnly),
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
      requirements.appOnlyWidgets.includes(name),
    );
    const degradedFallback = unrenderable.filter(
      (name) => !requirements.appOnlyWidgets.includes(name),
    );

    if (blockedAppOnly.length > 0) {
      const count = blockedAppOnly.length;
      findings.push({
        lane: "apps",
        severity: "blocker",
        code: "app_only_unrenderable",
        tools: blockedAppOnly,
        title: `${count} app-only tool${count === 1 ? "" : "s"} unusable`,
        detail: `${formatToolNames(blockedAppOnly)} ${count === 1 ? "is" : "are"} app-only (hidden from the model, no text fallback) and need${count === 1 ? "s" : ""} a UI ${profile.label} can't render — so ${count === 1 ? "it's" : "they're"} dead here.`,
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
        title: `${count} widget${count === 1 ? "" : "s"} fall back to text`,
        detail: `${formatToolNames(degradedFallback)} declare${count === 1 ? "s" : ""} a UI ${profile.label} won't render — users get the plain-text result instead.`,
        remediation,
        provenance: profile.provenance,
      });
    }

    // 2. Capability gaps — SERVER-SPECIFIC: only for widgets that actually use
    //    a capability (from the L1 scan) the host lacks.
    if (profile.capabilities && requirements.widgetUsage) {
      for (const check of CAPABILITY_CHECKS) {
        const tools = requirements.widgetUsage[check.key];
        if (tools && tools.length > 0 && profile.capabilities[check.key] !== true) {
          findings.push({
            lane: "apps",
            severity: check.severity,
            code: "capability_unsupported",
            capability: check.key,
            // Copy: `tools` is the shared `widgetUsage[key]` array — don't let a
            // finding alias (and let a surface mutate) the requirements object.
            tools: [...tools],
            title: check.title,
            detail: `${formatToolNames(tools)} need \`${check.api}\`, which ${profile.label} doesn't support — ${check.consequence}.`,
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
      detail: `This server negotiated MCP \`${serverVersion}\`; ${profile.label} advertises ${hostVersions
        .map((v) => `\`${v}\``)
        .join(
          ", ",
        )}. The host may negotiate a shared version — but if the server can't speak one of these, the connection won't establish.`,
      remediation: `Confirm the server also supports ${hostVersions.length === 1 ? "this version" : "one of these versions"}.`,
      provenance: profile.provenance,
    });
  }

  const apps = laneVerdict(
    findings,
    "apps",
    requirements.unknownDimensions.length > 0,
    profile.provenance,
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
    profile.provenance,
  );
  const verdict =
    VERDICT_RANK[apps.verdict] >= VERDICT_RANK[server.verdict]
      ? apps.verdict
      : server.verdict;

  return {
    hostId: profile.id,
    hostLabel: profile.label,
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
}

/**
 * Evaluate a server against a set of host profiles. The caller supplies the
 * profiles (the SDK ships the engine, not a fixed host catalog — a market-host
 * catalog comes in a follow-up so CLI/API/UI can share one).
 */
export function evaluateAllHosts(
  toolsData: HostCompatToolsInput | null | undefined,
  profiles: HostCompatProfile[],
  options?: EvaluateAllHostsOptions,
): HostCompatEvaluation {
  const requirements = deriveServerRequirements(
    toolsData,
    options?.widgetUsage,
    options?.connectionFacts,
  );
  return {
    requirements,
    reports: profiles.map((profile) =>
      evaluateHostCompat(requirements, profile),
    ),
  };
}
