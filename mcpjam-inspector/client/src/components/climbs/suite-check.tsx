import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { SuiteCheck as SuiteCheckData } from "@mcpjam/sdk/climbs";
import { Button } from "@mcpjam/design-system/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { AgentPromptDialog } from "./agent-prompt-dialog";
import { plural } from "./climb-format";
import { FINDING_LABELS } from "./ready-model";

/** What the baseline says about whether the suite can show a change, in the backend's own sentences. */
export function SuiteCheck({
  check,
  suiteName,
  serverName,
}: {
  check: SuiteCheckData | undefined;
  suiteName: string;
  serverName: string;
}) {
  const [adding, setAdding] = useState(false);
  if (!check?.ready) return null;
  const summary = !check.canShowChange
    ? "This suite cannot show a change yet. Add iterations or cases."
    : check.findings.length === 0
      ? "Nothing to flag."
      : plural(check.findings.length, "thing") + " to know.";
  const uncovered = check.steeringToolsWithoutValidation.length > 0;
  return (
    <Collapsible className="rounded-lg border border-border">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm">
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
          <span className="font-medium">Suite check</span>
          <span className="text-muted-foreground">{summary}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border px-4 py-3">
        {check.findings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No case flipped between the two baseline runs, and every environment has room to improve.
          </p>
        ) : (
          <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm">
            {check.findings.map((finding) => (
              <div key={`${finding.code}:${finding.environmentId ?? ""}:${finding.message}`} className="contents">
                <dt className="text-muted-foreground">{FINDING_LABELS[finding.code]}</dt>
                <dd>{finding.message}</dd>
              </div>
            ))}
          </dl>
        )}
        {uncovered ? (
          <Button variant="link" className="mt-2 h-auto p-0 text-sm" onClick={() => setAdding(true)}>
            Add cases with your agent
          </Button>
        ) : null}
      </CollapsibleContent>
      <AgentPromptDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add cases with your agent"
        note="Copy this into your coding agent."
        prompt={`Use MCPJam to add eval cases to the suite "${suiteName}". Write 3 validation cases for the tools that have none, and check each one against ${serverName} before you save it.`}
      />
    </Collapsible>
  );
}
