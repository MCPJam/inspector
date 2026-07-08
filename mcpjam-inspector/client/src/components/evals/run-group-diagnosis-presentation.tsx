/**
 * Presentational pieces for cross-host group findings, shared by the
 * scope-adaptive insights banner (SuiteInsightsCollapsible group mode). Pure
 * rendering + the fix-prompt builder — no data fetching.
 */
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import type { RunGroupQualityResult } from "./types";

export type GroupFinding = RunGroupQualityResult["findings"][number];

export const SEVERITY_CLASS: Record<GroupFinding["severity"], string> = {
  critical: "bg-destructive/10 text-destructive",
  warning: "bg-warning/10 text-warning",
  info: "bg-muted/60 text-muted-foreground",
};

export const CATEGORY_LABEL: Record<GroupFinding["category"], string> = {
  host_divergence: "Host divergence",
  all_hosts_failed: "All hosts failed",
  tool_path_divergence: "Tool path",
  efficiency_divergence: "Efficiency",
  environment_failure: "Environment",
};

export const ATTRIBUTION_LABEL: Record<GroupFinding["attribution"], string> = {
  server_design: "Server design",
  host_prompt: "Host prompt",
  model_behavior: "Model behavior",
  test_design: "Test design",
  environment: "Environment",
  unknown: "Unattributed",
};

export function buildGroupFixPrompt(
  finding: GroupFinding,
  result: RunGroupQualityResult,
): string {
  const lines: string[] = [];
  lines.push(`# Cross-host eval finding: ${finding.title}`);
  lines.push("");
  lines.push(`Overall: ${result.summary}`);
  lines.push("");
  lines.push(`Category: ${CATEGORY_LABEL[finding.category]}`);
  lines.push(
    `Likely cause (attribution): ${ATTRIBUTION_LABEL[finding.attribution]} (confidence: ${finding.confidence})`,
  );
  if (finding.affectedHosts.length > 0) {
    lines.push(`Affected host(s): ${finding.affectedHosts.join(", ")}`);
  }
  if (finding.baselineHosts.length > 0) {
    lines.push(`Compared against: ${finding.baselineHosts.join(", ")}`);
  }
  if (finding.caseTitle || finding.caseKey) {
    lines.push(`Case: ${finding.caseTitle ?? finding.caseKey}`);
  }
  if (finding.evidence.length > 0) {
    lines.push("");
    lines.push("Evidence:");
    for (const e of finding.evidence) lines.push(`- ${e}`);
  }
  lines.push("");
  lines.push(`Recommendation: ${finding.recommendation}`);
  lines.push("");
  lines.push(
    "Using the attribution above, modify the MCP server, the test case, or the host configuration to close this cross-host gap.",
  );
  return lines.join("\n");
}

async function copyWithToast(text: string, successLabel: string) {
  const ok = await copyToClipboard(text);
  if (ok) toast.success(successLabel);
  else toast.error("Copy failed");
}

function HostChips({ hosts, tone }: { hosts: string[]; tone: string }) {
  if (hosts.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {hosts.map((h) => (
        <span
          key={h}
          className={cn(
            "whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[10px]",
            tone,
          )}
        >
          {h}
        </span>
      ))}
    </span>
  );
}

export function GroupFindingItem({
  finding,
  result,
}: {
  finding: GroupFinding;
  result: RunGroupQualityResult;
}) {
  return (
    <li className="py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
                SEVERITY_CLASS[finding.severity],
              )}
            >
              {finding.severity}
            </span>
            <span className="rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {CATEGORY_LABEL[finding.category]}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {ATTRIBUTION_LABEL[finding.attribution]} · {finding.confidence}
            </span>
          </div>
          <p className="mt-1.5 text-sm leading-snug text-foreground">
            {finding.title}
          </p>
          {(finding.affectedHosts.length > 0 ||
            finding.baselineHosts.length > 0) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <HostChips
                hosts={finding.affectedHosts}
                tone="bg-destructive/10 text-destructive"
              />
              {finding.baselineHosts.length > 0 && (
                <>
                  <span>vs</span>
                  <HostChips
                    hosts={finding.baselineHosts}
                    tone="bg-muted/60 text-muted-foreground"
                  />
                </>
              )}
            </div>
          )}
          {finding.evidence.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {finding.evidence.slice(0, 4).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {finding.recommendation && (
            <p className="mt-1.5 text-xs leading-snug text-foreground/80">
              <span className="font-medium text-foreground">Fix: </span>
              {finding.recommendation}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 px-0 text-muted-foreground hover:text-foreground"
          title={`Copy a fix prompt for your coding agent (${finding.title})`}
          aria-label={`Copy fix prompt: ${finding.title}`}
          onClick={() =>
            copyWithToast(
              buildGroupFixPrompt(finding, result),
              "Fix prompt copied — paste into your agent",
            )
          }
        >
          <Copy className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </li>
  );
}

export function GroupFindingList({ result }: { result: RunGroupQualityResult }) {
  if (result.findings.length === 0) return null;
  return (
    <ul className="divide-y divide-border/50">
      {result.findings.map((f, i) => (
        <GroupFindingItem key={i} finding={f} result={result} />
      ))}
    </ul>
  );
}
