import { useMemo } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Info,
  Wrench,
} from "lucide-react";
import type { ServerWithName } from "@/state/app-types";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import { evaluateAllHosts } from "@/lib/host-compat/engine";
import type {
  CompatFinding,
  CompatProvenance,
  CompatVerdict,
} from "@/lib/host-compat/types";

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
}: {
  server: ServerWithName;
  toolsData?: ListToolsResultWithMetadata | null;
}) {
  const { requirements, reports } = useMemo(
    () => evaluateAllHosts(server, toolsData),
    [server, toolsData],
  );

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
                    : "No issues found in the data captured so far."}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
