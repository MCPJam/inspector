/**
 * What the share dialog builds from a saved run: the card's data, the post
 * text, and the X and LinkedIn share URLs.
 */

import {
  canDrawShareCard,
  formatShareCardScore,
  type ConformanceShareCardData,
} from "@/shared/conformance-share-card";

/** The fields of `conformanceRuns:getRun` the card reads. */
export type ShareableRunDetail = {
  score: number | null;
  outcome: string | null;
  applicable: number;
  passed: number;
  failed: number;
  couldNotRun: number;
  notApplicable: number;
  advisoryCount?: number;
  protocolVersion?: string | null;
  reports: Array<{
    suiteKind: string;
    applicable: number;
    passed: number;
    failed: number;
    couldNotRun: number;
  }>;
};

/** The card for a run, or null when the run has no score to show. */
export function shareCardDataFromRun(
  run: ShareableRunDetail,
  {
    serverName,
    siteLabel,
  }: { serverName?: string | null; siteLabel?: string | null },
): ConformanceShareCardData | null {
  if (run.score === null || !run.outcome) return null;
  const data: ConformanceShareCardData = {
    serverName: serverName ?? null,
    score: run.score,
    outcome: run.outcome,
    applicable: run.applicable,
    passed: run.passed,
    failed: run.failed,
    couldNotRun: run.couldNotRun,
    notApplicable: run.notApplicable,
    advisoryCount: run.advisoryCount ?? 0,
    protocolVersion: run.protocolVersion ?? null,
    suites: run.reports.map((report) => ({
      kind: report.suiteKind,
      applicable: report.applicable,
      passed: report.passed,
      failed: report.failed,
      couldNotRun: report.couldNotRun,
    })),
    siteLabel: siteLabel ?? null,
  };
  return canDrawShareCard(data) ? data : null;
}

/** The post's text. The link travels separately, so it is not repeated. */
export function sharePostText(data: ConformanceShareCardData): string {
  const subject = data.serverName ? `${data.serverName} scored` : "Scored";
  const checks = `${data.passed}/${data.applicable} checks`;
  const version = data.protocolVersion ? `, MCP ${data.protocolVersion}` : "";
  return `${subject} ${formatShareCardScore(data.score)}/100 on MCP conformance (${checks}${version}) with @mcpjam.`;
}

export function xShareUrl(text: string, url: string): string {
  const params = new URLSearchParams({ text, url });
  return `https://x.com/intent/post?${params}`;
}

export function linkedInShareUrl(url: string): string {
  const params = new URLSearchParams({ url });
  return `https://www.linkedin.com/sharing/share-offsite/?${params}`;
}

/** "mcp-conformance-amazon-test-85.7.png" */
export function shareCardFileName(data: ConformanceShareCardData): string {
  const slug = (data.serverName ?? "run")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `mcp-conformance-${slug || "run"}-${formatShareCardScore(data.score)}.png`;
}
