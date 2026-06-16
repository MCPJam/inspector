import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  HelpCircle,
  Info,
  Loader2,
  Wrench,
} from "lucide-react";
import { useNavigate } from "react-router";
import { usePostHog } from "posthog-js/react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import type { ServerWithName } from "@/state/app-types";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import { evaluateAllHosts } from "@/lib/host-compat/engine";
import { useActiveServerTunnel } from "@/lib/host-compat/use-active-tunnel";
import type {
  CompatFinding,
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
  HOST_TEMPLATES.map((t) => [t.id, t.label]),
);

const isHostTemplateId = (id: string): id is HostTemplateId =>
  COMPAT_TEMPLATE_LABEL.has(id);

const VERDICT_BADGE: Record<
  CompatVerdict,
  { label: string; className: string; Icon: typeof CheckCircle2 }
> = {
  works: {
    label: "Works",
    className:
      "border-emerald-300/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    Icon: CheckCircle2,
  },
  degraded: {
    label: "Degraded",
    className:
      "border-amber-300/60 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    Icon: AlertTriangle,
  },
  blocked: {
    label: "Blocked",
    className:
      "border-red-300/60 bg-red-500/10 text-red-700 dark:text-red-300",
    Icon: AlertCircle,
  },
  unknown: {
    label: "Unknown",
    className: "border-border bg-muted/40 text-muted-foreground",
    Icon: HelpCircle,
  },
};

const PROVENANCE_LABEL: Record<CompatProvenance, string> = {
  "vendor-doc": "from vendor docs",
  probe: "probe-captured",
  assumed: "best-effort preset",
};

const FINDING_ICON: Record<
  CompatFinding["severity"],
  { Icon: typeof Info; className: string }
> = {
  blocker: { Icon: AlertCircle, className: "text-red-500" },
  degraded: { Icon: AlertTriangle, className: "text-amber-500" },
  info: { Icon: Info, className: "text-muted-foreground" },
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
  // Resolve tunnel state the same way the card does, so a tunneled stdio
  // server isn't blocked here while the card strip shows it reachable.
  const hasActiveTunnel = useActiveServerTunnel(server.name);
  const { requirements, reports } = useMemo(
    () => evaluateAllHosts(server, toolsData, { hasActiveTunnel }),
    [server, toolsData, hasActiveTunnel],
  );

  const posthog = usePostHog();
  const navigate = useNavigate();
  const { createHost } = useHostMutations();
  const [, setPreviewedHostId] = usePreviewedHostId(projectId ?? null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  // Which host's CTA is mid-create (drives its spinner + disables the rest).
  const [creatingTemplateId, setCreatingTemplateId] = useState<string | null>(
    null,
  );

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
        err instanceof Error ? err.message : `Couldn't open in ${label}`,
      );
    } finally {
      setCreatingTemplateId(null);
    }
  };

  return (
    <div className="space-y-3 pb-4">
      <p className="text-xs text-muted-foreground">
        Prototype · static checks computed from connect-time data. Host
        capability profiles are best-effort — each verdict shows where its
        facts come from.
      </p>

      {requirements.unknownDimensions.length > 0 && (
        <div className="rounded-md border border-border/60 bg-muted/30 p-2 text-xs text-muted-foreground">
          Incomplete picture: missing {requirements.unknownDimensions.join("; ")}
          .
        </div>
      )}

      <div className="space-y-2">
        {reports.map((report) => {
          const badge = VERDICT_BADGE[report.verdict];
          return (
            <div
              key={report.hostId}
              className="rounded-lg border border-border/60 bg-card/40 p-3"
            >
              <div className="flex items-center gap-2">
                <img
                  src={report.logoSrc}
                  alt=""
                  className="h-4 w-4 rounded-[3px] object-contain"
                />
                <span className="text-sm font-medium text-foreground">
                  {report.hostLabel}
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${badge.className}`}
                >
                  <badge.Icon className="h-3 w-3" />
                  {badge.label}
                </span>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {PROVENANCE_LABEL[report.provenance]}
                </span>
              </div>

              {report.findings.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {report.findings.map((finding, index) => {
                    const icon = FINDING_ICON[finding.severity];
                    return (
                      <li key={index} className="flex gap-2 text-xs">
                        <icon.Icon
                          className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${icon.className}`}
                        />
                        <div className="min-w-0">
                          <span className="font-medium text-foreground">
                            {finding.title}
                          </span>
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
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  {report.verdict === "works"
                    ? "Everything this server uses is supported."
                    : report.verdict === "unknown"
                      ? "No blockers found, but some dimensions couldn't be checked yet — connect and load tools for a complete report."
                      : "No issues found in the data captured so far."}
                </p>
              )}

              {canCreateHosts && isHostTemplateId(report.hostId) && (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
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
                        Test in {report.hostLabel}
                        <ArrowUpRight className="h-3 w-3" />
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
