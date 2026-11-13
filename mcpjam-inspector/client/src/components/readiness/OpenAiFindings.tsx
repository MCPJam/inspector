/**
 * The ChatGPT portal's Findings panel beside each tab: the portal's own
 * issues with the answers, then MCPJam's open results marked "MCPJam", one
 * row per coded portal rule where a result carries them. "All" and
 * "Blocking" filter it, and the copy button takes what is shown, to paste
 * into a coding agent as the portal suggests.
 */
import { useState, type ReactNode } from "react";
import { ChevronRight, Copy } from "lucide-react";
import type {
  DirectoryFieldIssue,
  PlacedFinding,
  PlacedStep,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { CheckResult, McpjamMark, openResult } from "./McpjamChecks";

export interface FindingRow {
  id: string;
  text: string;
  /** The file a portal rule is about. */
  subject?: string;
  blocking: boolean;
  /** MCPJam's result; absent for the portal's own issue with an answer. */
  entry?: PlacedFinding;
}

/** The portal's chips: a status in its tone, or neutral. */
export function Chip({
  tone,
  children,
}: {
  tone?: "good" | "warn";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        // The capture's coloured text is dark mode's; on a light tint it fades.
        tone === "good" && "bg-success/15 text-foreground dark:text-success",
        tone === "warn" && "bg-warning/15 text-foreground dark:text-warning",
        !tone && "bg-accent text-foreground",
      )}
    >
      {children}
    </span>
  );
}

const textOf = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : undefined;

/** Whether a result names a skill or tool, by its name or its folder. */
export function mentions(entry: PlacedFinding, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const { remediation, details } = entry.finding;
  return new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`).test(
    JSON.stringify([remediation, details]),
  );
}

/** A result that holds: checked on current evidence, with nothing open. */
export const holds = (entry: PlacedFinding) =>
  entry.evidenceStatus === "established" && !openResult(entry);

/** The portal's coded rules a package result carries, in the portal's words. */
function portalRules(entry: PlacedFinding): FindingRow[] {
  const rules = entry.finding.details?.portalIssues;
  return (Array.isArray(rules) ? rules : []).flatMap((rule: unknown, index) => {
    if (typeof rule !== "object" || rule === null) return [];
    const text = "message" in rule ? textOf(rule.message) : undefined;
    if (!text) return [];
    const subject = "subject" in rule ? textOf(rule.subject) : undefined;
    const blocking = "severity" in rule && rule.severity === "blocking";
    return [{ id: `${entry.finding.id}:${index}`, text, subject, blocking, entry }];
  });
}

/** The portal's issues first, then MCPJam's open results, blockers first. */
export function findingRows(
  issues: readonly DirectoryFieldIssue[],
  findings: readonly PlacedFinding[],
): FindingRow[] {
  const results = findings.flatMap((entry): FindingRow[] => {
    const kind = openResult(entry);
    if (!kind) return [];
    const rules = portalRules(entry);
    const { id, remediation, title } = entry.finding;
    const blocking = kind === "Blocker";
    return rules.length > 0
      ? rules
      : [{ id, text: remediation ?? title, blocking, entry }];
  });
  const own = issues.map((issue) => ({
    id: `${issue.step}:${issue.key}`,
    text: issue.message,
    blocking: true,
  }));
  return [...own, ...results.sort((a, b) => +b.blocking - +a.blocking)];
}

/** The shown rows as text, with where each came from. */
export function findingsText(heading: string, rows: readonly FindingRow[]) {
  const line = (row: FindingRow) =>
    `- ${row.blocking ? "Blocking" : "Non-blocking"}${row.entry ? ", found by MCPJam" : ""}: ${row.text}${row.subject ? ` (${row.subject})` : ""}`;
  return [heading, ...rows.map(line)].join("\n");
}

function Row({ row }: { row: FindingRow }) {
  const [open, setOpen] = useState(false);
  const body = (
    <span className="min-w-0 flex-1">
      {row.text}
      {row.subject ? (
        <span className="block break-all text-xs text-muted-foreground">
          {row.subject}
        </span>
      ) : null}
      <span className="mt-1 flex flex-wrap gap-1">
        <Chip tone={row.blocking ? "warn" : undefined}>
          {row.blocking ? "Blocking" : "Non-blocking"}
        </Chip>
        {row.entry ? <McpjamMark /> : null}
        {row.entry?.finding.provenance === "llm" ? (
          <Chip>Read by a model</Chip>
        ) : null}
      </span>
    </span>
  );
  const line = "flex w-full items-start gap-2 px-3 py-2.5 text-left text-sm";
  // Only MCPJam's rows open, on the result behind them.
  return (
    <li className="border-b border-border last:border-b-0">
      {row.entry ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={cn(line, "outline-none focus-visible:ring-2 focus-visible:ring-ring")}
        >
          {body}
          <ChevronRight
            aria-hidden="true"
            className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground", open && "rotate-90")}
          />
        </button>
      ) : (
        <div className={line}>{body}</div>
      )}
      {open && row.entry ? (
        <ul className="px-3 pb-3">
          <CheckResult entry={row.entry} />
        </ul>
      ) : null}
    </li>
  );
}

export function OpenAiFindings({
  text,
  tab,
  issues,
  steps,
  hasRun,
}: {
  /** The portal's words, from the flow's findings block. */
  text: Partial<Record<string, string>>;
  /** The tab's title, which names what a copy holds. */
  tab: string;
  issues: readonly DirectoryFieldIssue[];
  /** The tab's steps as the last run placed them. */
  steps: readonly PlacedStep[];
  hasRun: boolean;
}) {
  const [filter, setFilter] = useState("all");
  const rows = findingRows(issues, steps.flatMap((step) => step.findings));
  const shown = rows.filter((row) => filter === "all" || row.blocking);
  const total = (key: "passed" | "blockers" | "likelyFlags" | "notChecked") =>
    steps.reduce((sum, step) => sum + step.counts[key], 0);
  const evaluated = total("passed") + total("blockers") + total("likelyFlags");
  const waiting = total("notChecked");
  let empty = `No findings in ${evaluated} evaluated ${evaluated === 1 ? "check" : "checks"}`;
  empty += waiting > 0 ? `; ${waiting} still need evidence.` : ".";
  if (!hasRun) empty = "No findings yet. Run checks to grade this version.";
  if (rows.length > 0) empty = "No blocking findings.";
  const copy = async () => {
    const heading = `${tab} findings from an MCPJam rehearsal of the ChatGPT portal`;
    if (await copyToClipboard(findingsText(heading, shown))) {
      toast.success("Findings copied.");
    } else {
      toast.error("The findings were not copied. Select them in the list and copy them.");
    }
  };
  return (
    <aside
      aria-label={text.title}
      className="w-[21rem] shrink-0 space-y-3 border-l border-border py-6 pl-6"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">{text.title}</h2>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={filter}
          onValueChange={(value) => value && setFilter(value)}
        >
          <ToggleGroupItem value="all" className="flex-none px-2.5">
            {text.all}
          </ToggleGroupItem>
          <ToggleGroupItem value="blocking" className="flex-none px-2.5">
            {text.blocking}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <McpjamMark />
        Found in this rehearsal, where the portal lists its own.
      </p>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border">
          {shown.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={shown.length === 0}
        onClick={() => void copy()}
      >
        <Copy aria-hidden="true" />
        {text.copy}
      </Button>
    </aside>
  );
}
