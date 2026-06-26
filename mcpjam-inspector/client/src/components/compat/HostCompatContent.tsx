import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  Info,
  Loader2,
  Wrench,
} from "lucide-react";
import { useNavigate } from "react-router";
import { usePostHog } from "posthog-js/react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { ServerWithName } from "@/state/app-types";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import { evaluateAllHosts } from "@/lib/host-compat/engine";
import { useWidgetUsage } from "@/lib/host-compat/use-widget-usage";
import type {
  CompatFinding,
  CompatLane,
  CompatProvenance,
  CompatVerdict,
  HostCompatReport,
} from "@/lib/host-compat/types";
import { standardEventProps } from "@/lib/PosthogUtils";
import { routePaths } from "@/lib/app-navigation";
import { useHostMutations } from "@/hooks/useClients";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  HOST_TEMPLATES,
  seedFromHostTemplate,
  type HostTemplateId,
} from "@/lib/client-templates";

/** Compat profile ids (`claude`, `chatgpt`, …) are the same string literals
 * as the host template ids, so a verdict maps to a template with no lookup
 * table — but we still gate on the catalog so a profile id that ever drifts
 * away from a real template silently hides its CTA instead of crashing. */
const COMPAT_TEMPLATE_LABEL = new Map<string, string>(
  HOST_TEMPLATES.map((t) => [t.id, t.label])
);

const isHostTemplateId = (id: string): id is HostTemplateId =>
  COMPAT_TEMPLATE_LABEL.has(id);

/** Lightweight verdict styling: a colored dot + colored label, no pill —
 * keeps each host row to a single quiet line. */
const VERDICT_META: Record<
  CompatVerdict,
  { label: string; dot: string; text: string }
> = {
  works: {
    label: "Works",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  degraded: {
    label: "Degraded",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
  blocked: {
    label: "Blocked",
    dot: "bg-red-500",
    text: "text-red-600 dark:text-red-400",
  },
  unknown: {
    label: "Unknown",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
};

const PROVENANCE_LABEL: Record<CompatProvenance, string> = {
  observed: "Observed from a live run",
  "vendor-doc": "Verified from vendor docs",
  probe: "Probe-captured from a real host",
  assumed: "Best-effort preset — unverified",
};

const FINDING_ICON: Record<
  CompatFinding["severity"],
  { Icon: typeof Info; className: string }
> = {
  blocker: { Icon: AlertCircle, className: "text-red-500" },
  degraded: { Icon: AlertTriangle, className: "text-amber-500" },
  info: { Icon: Info, className: "text-muted-foreground" },
};

/** Findings split into two axes — see `CompatLane`. Apps first (where hosts
 * most visibly differ), then Server (capability negotiation). */
const LANE_ORDER = ["apps", "server"] as const;
const LANE_LABEL: Record<CompatLane, string> = {
  apps: "Apps",
  server: "Server",
};

/**
 * Per-host compatibility report for the server detail modal's
 * Compatibility tab. Prototype of the L0 static report in
 * `design-explorations/host-compat-report.md`.
 */
export function HostCompatContent({
  server,
  toolsData,
  projectId,
  serverId,
  onClose,
}: {
  server: ServerWithName;
  toolsData?: ListToolsResultWithMetadata | null;
  /** Convex project id — required to create a host. */
  projectId?: string | null;
  /** Project-server-ref id to attach to the new host (the modal resolves it
   * from `hostedServerId`). Without it we can't attach this server, so the
   * CTA hides rather than create an empty host. */
  serverId?: string | null;
  /** Close the detail modal before we navigate to the playground. */
  onClose?: () => void;
}) {
  const widgetUsage = useWidgetUsage(server.name, toolsData);
  const protocolVersion = server.initializationInfo?.protocolVersion;
  const { requirements, reports } = useMemo(
    () => evaluateAllHosts(toolsData, widgetUsage, { protocolVersion }),
    [toolsData, widgetUsage, protocolVersion]
  );

  const posthog = usePostHog();
  const navigate = useNavigate();
  const { createHost } = useHostMutations();
  const [, setPreviewedHostId] = usePreviewedHostId(projectId ?? null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  // Which host's CTA is mid-create (drives its spinner + disables the rest).
  const [creatingTemplateId, setCreatingTemplateId] = useState<string | null>(
    null
  );
  // Findings are collapsed by default — the row shows a terse summary; the
  // full list expands on demand so the tab reads as a scannable list.
  const [expandedHostId, setExpandedHostId] = useState<string | null>(null);
  const toggleExpanded = (hostId: string) =>
    setExpandedHostId((current) => (current === hostId ? null : hostId));

  // Top of the host-creation funnel: one "tab viewed" per server so the
  // compat → create conversion is measurable. Re-arms on server switch.
  const viewedServerRef = useRef<string | null>(null);
  useEffect(() => {
    if (viewedServerRef.current === server.name) return;
    viewedServerRef.current = server.name;
    posthog.capture("host_compat_tab_viewed", {
      ...standardEventProps("compat_detail_modal"),
      server_name: server.name,
      host_count: reports.length,
    });
    // Intentionally keyed on server.name only — reports churn as tools load,
    // but this is a once-per-server view signal, not a verdict snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.name]);

  // The CTA that turns a verdict into a host: create a host from the
  // matching template with THIS server attached, select it, and jump to the
  // playground. This is the insight → creation bridge the design doc calls
  // for ("Open in emulated {host}").
  const canCreateHosts = Boolean(projectId && serverId);
  const handleTestInHost = async (report: HostCompatReport) => {
    const templateId = report.hostId;
    if (!projectId || !serverId || !isHostTemplateId(templateId)) return;
    const label = COMPAT_TEMPLATE_LABEL.get(templateId) ?? report.hostLabel;

    posthog.capture("compat_cta_clicked", {
      ...standardEventProps("compat_detail_modal"),
      template_id: templateId,
      host_label: report.hostLabel,
      verdict: report.verdict,
      server_name: server.name,
    });

    setCreatingTemplateId(templateId);
    try {
      const seed = seedFromHostTemplate(templateId, { theme: themeMode });
      const { hostId, hostConfigId } = await createHost({
        projectId,
        name: label,
        input: { ...seed, serverIds: [serverId] },
      });
      // Same event the create dialog fires, so host creation stays one
      // unified number — filter on `via`/`location` to isolate CTA-driven
      // creates. Best-effort: a posthog throw must not surface a failure
      // toast after the host already exists.
      try {
        posthog.capture("client_created", {
          ...standardEventProps("compat_cta"),
          via: "compat_report",
          template_id: templateId,
          client_id: hostId,
          client_config_id: hostConfigId,
          server_count: 1,
        });
      } catch {
        // swallow — analytics must not block the success path
      }
      setPreviewedHostId(hostId);
      onClose?.();
      navigate(routePaths.playground);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Couldn't open in ${label}`
      );
    } finally {
      setCreatingTemplateId(null);
    }
  };

  return (
    <div className="pb-4">
      <p className="pb-1 text-[11px] text-muted-foreground">
        Static checks from connect-time data · best-effort host profiles
        {requirements.unknownDimensions.length > 0
          ? ` · incomplete (${requirements.unknownDimensions.join(", ")})`
          : ""}
      </p>

      <div className="divide-y divide-border/50">
        {reports.map((report) => {
          const verdict = VERDICT_META[report.verdict];
          const hasFindings = report.findings.length > 0;
          const isOpen = expandedHostId === report.hostId;
          const summary = hasFindings
            ? `${report.findings[0].title}${
                report.findings.length > 1
                  ? ` +${report.findings.length - 1}`
                  : ""
              }`
            : "";
          return (
            <div key={report.hostId} className="py-2.5 first:pt-1.5">
              <div className="flex items-center gap-2">
                <img
                  src={report.logoSrcByTheme?.[themeMode] ?? report.logoSrc}
                  alt=""
                  className="h-4 w-4 flex-shrink-0 rounded-[3px] object-contain"
                />
                <span className="text-sm font-medium text-foreground">
                  {report.hostLabel}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={`inline-flex flex-shrink-0 items-center gap-1.5 text-xs ${verdict.text}`}
                      aria-label={
                        report.verdict === "works" ? verdict.label : undefined
                      }
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${verdict.dot}`}
                      />
                      {report.verdict !== "works" && verdict.label}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" variant="muted">
                    {PROVENANCE_LABEL[report.provenance]}
                  </TooltipContent>
                </Tooltip>

                {hasFindings ? (
                  <button
                    type="button"
                    onClick={() => toggleExpanded(report.hostId)}
                    aria-expanded={isOpen}
                    className="flex min-w-0 flex-1 items-center gap-1 rounded-md text-left text-xs text-muted-foreground hover:text-foreground"
                  >
                    <span className="truncate">{summary}</span>
                    <ChevronDown
                      className={`h-4 w-4 flex-shrink-0 transition-transform ${
                        isOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                ) : (
                  <div className="min-w-0 flex-1" aria-hidden />
                )}

                <div className="flex flex-shrink-0 items-center">
                  {canCreateHosts && isHostTemplateId(report.hostId) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                      disabled={creatingTemplateId !== null}
                      onClick={() => handleTestInHost(report)}
                    >
                      {creatingTemplateId === report.hostId ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Opening…
                        </>
                      ) : (
                        <>
                          Test
                          <ArrowUpRight className="h-3 w-3" />
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>

              {hasFindings && isOpen && (
                <div className="mt-2 space-y-2.5 pl-6">
                  {LANE_ORDER.map((lane) => {
                    const laneFindings = report.findings.filter(
                      (f) => f.lane === lane
                    );
                    if (laneFindings.length === 0) return null;
                    const laneDot = VERDICT_META[report.lanes[lane].verdict].dot;
                    return (
                      <div key={lane}>
                        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          <span
                            className={`h-1 w-1 rounded-full ${laneDot}`}
                          />
                          {LANE_LABEL[lane]}
                        </div>
                        <ul className="space-y-1.5">
                          {laneFindings.map((finding, index) => {
                            const icon = FINDING_ICON[finding.severity];
                            // Phase 1: a finding's provenance equals the host
                            // baseline, so this badge stays hidden. It surfaces
                            // when a Tier-2 live run stamps `observed`.
                            const showProvenance =
                              finding.provenance !== report.provenance;
                            return (
                              <li key={index} className="flex gap-2 text-xs">
                                <icon.Icon
                                  className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${icon.className}`}
                                />
                                <div className="min-w-0">
                                  <span className="font-medium text-foreground">
                                    {finding.title}
                                  </span>
                                  {showProvenance && (
                                    <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                      {finding.provenance}
                                    </span>
                                  )}
                                  <span className="text-muted-foreground">
                                    {" — "}
                                    {finding.detail}
                                  </span>
                                  {finding.remediation && (
                                    <div className="mt-1 flex items-start gap-1.5 text-muted-foreground">
                                      <Wrench className="mt-0.5 h-3 w-3 flex-shrink-0" />
                                      <span>{finding.remediation}</span>
                                    </div>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
