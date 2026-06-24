import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
} from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { ScrollableJsonView } from "@/components/ui/json-editor";
import type { XAADecodedJwt } from "@/lib/xaa/types";
import type { NegativeTestMode } from "@/shared/xaa.js";
import { NEGATIVE_TEST_MODE_DETAILS } from "@/shared/xaa.js";
import { copyToClipboard } from "@/lib/clipboard";
import {
  lintIdJag,
  type IdJagLintContext,
  type IdJagLintVerdict,
} from "@/lib/xaa/idjag-lint";

interface IdJagInspectorProps {
  rawJwt: string;
  decoded: XAADecodedJwt;
  negativeTestMode: NegativeTestMode;
  lintContext?: IdJagLintContext;
}

function LintVerdictRow({ verdict }: { verdict: IdJagLintVerdict }) {
  return (
    <div
      data-testid={`idjag-lint-${verdict.id}`}
      className="min-w-0 px-3 py-2"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <code className="shrink-0 text-xs font-mono font-medium">
          {verdict.claim}
        </code>
        <Badge
          variant="outline"
          className="h-auto shrink whitespace-normal break-words text-right text-[10px] font-normal leading-snug text-muted-foreground"
        >
          {verdict.citation.spec} {verdict.citation.section}
        </Badge>
      </div>
      {verdict.actual !== undefined && (
        <code className="mt-1 block min-w-0 break-all text-[11px] font-mono text-muted-foreground">
          {verdict.actual}
        </code>
      )}
    </div>
  );
}

export function IdJagInspector({
  rawJwt,
  decoded,
  negativeTestMode,
  lintContext,
}: IdJagInspectorProps) {
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  const lintVerdicts = useMemo(
    () => lintIdJag(decoded.header, decoded.payload, lintContext),
    [decoded.header, decoded.payload, lintContext],
  );
  const failCount = lintVerdicts.filter((v) => v.status === "fail").length;
  const warnCount = lintVerdicts.filter((v) => v.status === "warn").length;
  const lintSummary =
    failCount === 0 && warnCount === 0
      ? "All claims pass"
      : [
          failCount > 0 ? `${failCount} failing` : null,
          warnCount > 0 ? `${warnCount} warning` : null,
        ]
          .filter(Boolean)
          .join(", ");

  const handleCopy = async () => {
    const success = await copyToClipboard(rawJwt);
    if (!success) {
      return;
    }

    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      data-testid="idjag-inspector"
      className="min-w-0 bg-background border border-border rounded-lg shadow-sm"
    >
      <div className="flex min-w-0 items-start gap-2 px-4 py-3">
        <button
          type="button"
          data-testid="idjag-inspector-toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          {expanded ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">ID-JAG Inspector</h3>
              <Badge variant="secondary" className="text-[10px]">
                {NEGATIVE_TEST_MODE_DETAILS[negativeTestMode].label}
              </Badge>
              {!expanded && (
                <span className="text-[11px] text-muted-foreground">
                  {lintSummary}
                </span>
              )}
            </div>
            {expanded && (
              <p className="text-xs text-muted-foreground">
                Decode the assertion before sending it to the authorization
                server. Broken claims are called out explicitly below.
              </p>
            )}
          </div>
        </button>

        <Button
          variant="outline"
          size="sm"
          onClick={handleCopy}
          className="shrink-0 self-start"
        >
          <Copy className="h-3.5 w-3.5 mr-1" />
          {copied ? "Copied" : "Copy JWT"}
        </Button>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-border px-4 pb-4 pt-4">
          <div className="grid gap-2">
            {decoded.issues.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                No structural issues detected in the decoded ID-JAG.
              </div>
            ) : (
              decoded.issues.map((issue) => (
                <div
                  key={`${issue.section}-${issue.field}`}
                  className="border border-red-300 dark:border-red-900 rounded-md bg-red-50 dark:bg-red-950/20 px-3 py-2"
                >
                  <div className="flex items-center gap-2 text-xs font-medium text-red-700 dark:text-red-300">
                    <AlertTriangle className="h-4 w-4" />
                    {issue.label}
                  </div>
                  <div className="mt-1 text-xs text-red-700/90 dark:text-red-300/90">
                    Expected: {issue.expected}
                  </div>
                  <div className="text-xs text-red-700/90 dark:text-red-300/90">
                    Actual: {issue.actual}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="min-w-0 space-y-2">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-semibold">Claim lint</h4>
              <span className="text-[11px] text-muted-foreground">
                {lintSummary}
              </span>
            </div>
            <div className="min-w-0 divide-y divide-border rounded-md border border-border">
              {lintVerdicts.map((verdict) => (
                <LintVerdictRow key={verdict.id} verdict={verdict} />
              ))}
            </div>
          </div>

          <div className="grid min-w-0 gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Header
              </div>
              <ScrollableJsonView
                value={
                  decoded.header ?? { error: "Header could not be decoded" }
                }
                containerClassName="min-w-0 rounded-sm bg-muted/20 p-2 max-h-[280px]"
              />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Payload
              </div>
              <ScrollableJsonView
                value={
                  decoded.payload ?? { error: "Payload could not be decoded" }
                }
                containerClassName="min-w-0 rounded-sm bg-muted/20 p-2 max-h-[280px]"
              />
            </div>
          </div>

          <div className="min-w-0">
            <div className="text-xs font-medium text-muted-foreground mb-1">
              Signature
            </div>
            <div className="rounded-sm bg-muted/20 p-2 text-[11px] font-mono break-all text-muted-foreground">
              {decoded.signature || "(missing)"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
