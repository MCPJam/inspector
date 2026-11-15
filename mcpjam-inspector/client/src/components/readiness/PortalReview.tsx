/**
 * The portal's review page, drawn from the review step's layout: one section
 * per row of the portal's page, showing a summary line or how many fields to
 * fix, the rows under it with the portal's labels and error lines, and an
 * Edit link to the step. It checks answers as the review page does, so it
 * asks for what no step asks for (Claude's author) and can count one more
 * than the step rail, as the portal does.
 *
 * MCPJam's open results for a section's steps are listed under it, marked.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import {
  directoryFlowField,
  type DirectoryAnswerValue,
  type DirectoryFieldIssue,
  type DirectoryFlow,
  type DirectoryFlowField,
  type DirectoryFlowStep,
  type DirectoryReviewSection,
  type PlacedFinding,
  type PlacedStep,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import type { AnswerValues } from "@/hooks/use-directory-submission";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { McpjamMark, openResult } from "./McpjamChecks";

/** The portal's mark for an answer that is not there. */
const BLANK = "—";
const LINE =
  "grid grid-cols-[11rem_minmax(0,1fr)] gap-4 border-t border-border/70 py-2 first:border-t-0";

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

const listOf = (
  value: DirectoryAnswerValue | undefined,
): ReadonlyArray<string | Record<string, string>> =>
  Array.isArray(value) ? value : [];

/** An answer in the portal's words: option labels, the text, "Yes", or a dash. */
export function answerText(
  field: DirectoryFlowField | undefined,
  value: DirectoryAnswerValue | undefined,
): string {
  const label = (entry: string) =>
    field?.options?.find((option) => option.value === entry)?.label ?? entry;
  if (value === true) return "Yes";
  if (typeof value === "string") return value.trim() ? label(value) : BLANK;
  const list = listOf(value);
  if (list.length === 0) return BLANK;
  if (field?.control === "checkbox-group") {
    return `${new Set(list).size} of ${field.options?.length ?? 0}`;
  }
  const columns = field?.pairs?.keys ?? [];
  const shown = list
    .map((entry) =>
      typeof entry === "string"
        ? label(entry)
        : columns
            .map((column) => entry[column]?.trim())
            .filter(Boolean)
            .join(": "),
    )
    .filter(Boolean)
    .join(field?.pairs ? "\n" : ", ");
  return shown || BLANK;
}

type Read = (key: string) => string;

/**
 * The line each section of Claude's review page shows once nothing in it is
 * missing, in the portal's words; a section not listed shows its answers.
 * Connection shows only the URL: the portal adds the captured tool count,
 * and MCPJam's copy has no captured tool list to count.
 */
const CLAUDE_SUMMARIES: Record<
  string,
  (read: Read, values: AnswerValues) => string[]
> = {
  "connection-auth": (read, values) => [
    values["authentication.requirement"] === "none"
      ? "No authentication"
      : read("authentication.requirement") &&
        `Authentication ${read("authentication.requirement").toLowerCase()}`,
    read("authentication.oauthClient"),
  ],
  listing: (read) => [
    read("listing.name"),
    read("listing.slug"),
    read("listing.categories"),
  ],
  useCases: (read, values) => [
    read("useCases.access"),
    listOf(values["useCases.pairs"])
      .map((row) => (typeof row === "string" ? "" : row.useCase))
      .filter(Boolean)
      .join(", "),
  ],
  company: (read) => [read("company.name"), read("company.contactName")],
  authentication: (read) => [
    read("authentication.oauthClient") &&
      `OAuth 2.0 + ${read("authentication.oauthClient")}`,
  ],
  dataHandling: (read) => [
    read("dataHandling.apiOwnership"),
    read("dataHandling.healthData") &&
      `Health data: ${read("dataHandling.healthData")}`,
    read("dataHandling.sponsored") &&
      `Sponsored content: ${read("dataHandling.sponsored")}`,
  ],
  testLaunch: (read, values) => [
    read("testLaunch.instructions") && "Test instructions provided",
    values["testLaunch.selfTested"] === true
      ? "Tested with MCP Inspector"
      : "Not tested with MCP Inspector",
  ],
  // Shown only when none is missing, so every one is ticked.
  compliance: (read, values) => [
    `All ${new Set(listOf(values["compliance.acknowledgments"])).size} policies acknowledged`,
    read("compliance.additionalNotes") && "Additional information provided",
  ],
};

interface Row {
  label: string;
  value: string;
  error?: string;
}

function ReviewSection({
  section,
  rows,
  summary,
  results,
  onEdit,
}: {
  section: DirectoryReviewSection;
  rows: readonly Row[];
  summary: string;
  results: readonly PlacedFinding[];
  onEdit: () => void;
}) {
  const fix = rows.filter((row) => row.error).length;
  const blockers = results.filter(
    (entry) => openResult(entry) === "Blocker",
  ).length;
  const flags = results.length - blockers;
  const canOpen =
    !section.flat &&
    (results.length > 0 ||
      rows.some((row) => row.error || row.value !== BLANK));
  const [open, setOpen] = useState(fix > 0 || results.length > 0);
  const shownRows = canOpen && open ? rows : [];
  // A flat section never opens, but MCPJam's results still show under it.
  const shownResults = (canOpen && open) || section.flat ? results : [];
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="grid grid-cols-[11rem_minmax(0,1fr)_auto] items-start gap-4 text-sm">
        {canOpen ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex items-center gap-1.5 rounded-md text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {section.title}
            <Chevron
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          </button>
        ) : (
          <span
            className={section.flat ? "text-muted-foreground" : "font-medium"}
          >
            {section.title}
          </span>
        )}
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {fix > 0 ? (
            <span className="text-destructive">
              {plural(fix, "field")} to fix
            </span>
          ) : (
            <span className="min-w-0 truncate">{summary}</span>
          )}
          {blockers > 0 ? (
            <McpjamMark>{plural(blockers, "blocker")}</McpjamMark>
          ) : null}
          {flags > 0 ? (
            <McpjamMark>{plural(flags, "likely flag")}</McpjamMark>
          ) : null}
        </span>
        <button
          type="button"
          aria-label={`Edit ${section.title}`}
          onClick={onEdit}
          className="rounded-md text-ring underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Edit
        </button>
      </div>
      {shownRows.length + shownResults.length > 0 ? (
        <dl className="mt-2 text-sm">
          {shownRows.map((row) => (
            <div key={row.label} className={LINE}>
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words">
                {row.value}
                {row.error ? (
                  <span className="mt-1 block text-destructive">
                    Error: {row.error}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
          {shownResults.map((entry) => {
            const kind = openResult(entry);
            return (
              <div key={entry.finding.id} className={LINE}>
                <dt>
                  <McpjamMark>{kind}</McpjamMark>
                </dt>
                <dd
                  className={cn(
                    "min-w-0 break-words",
                    kind === "Blocker" && "text-destructive",
                  )}
                >
                  {entry.finding.title}
                  {entry.finding.remediation ? (
                    <span className="block text-muted-foreground">
                      {entry.finding.remediation}
                    </span>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
    </div>
  );
}

export function PortalReview({
  flow,
  step,
  values,
  issues,
  placed,
  onEdit,
}: {
  flow: DirectoryFlow;
  /** The review step. Its own results follow the page, not a section. */
  step: DirectoryFlowStep;
  values: AnswerValues;
  /** The answers checked as the review page checks them. */
  issues: readonly DirectoryFieldIssue[];
  placed: readonly PlacedStep[];
  onEdit: (step: string) => void;
}) {
  const sections = step.layout?.review ?? [];
  const read: Read = (key) => {
    const shown = answerText(directoryFlowField(flow, key), values[key]);
    return shown === BLANK ? "" : shown;
  };
  // A step's results go under the section named after it, else under the
  // section before it: the portal has no Tools row, so tool results sit
  // under Connection.
  const home = new Map<string, string>();
  let current: string | undefined;
  for (const entry of flow.steps) {
    if (sections.some((section) => section.id === entry.id)) {
      current = entry.id;
    }
    if (current && entry.id !== step.id) home.set(entry.id, current);
  }
  const openResults = placed
    .flatMap((entry) => entry.findings)
    .filter((entry) => openResult(entry))
    .sort(
      (a, b) =>
        Number(openResult(b) === "Blocker") -
        Number(openResult(a) === "Blocker"),
    );

  return (
    <div className="rounded-xl border border-border bg-card">
      {sections.map((section) => {
        const rows = section.rows.map((row): Row => {
          if (typeof row !== "string") {
            // Derived by the portal, such as the captured tool list: MCPJam
            // holds no value for it, only the error while it cannot exist.
            const error = read(row.blank) ? undefined : row.error;
            return { label: row.label, value: BLANK, error };
          }
          const field = directoryFlowField(flow, row);
          const error = issues.find((issue) => issue.key === row)?.message;
          let value = answerText(field, values[row]);
          // What stands in for a missing answer, such as Claude's company
          // name and website for the author.
          if (value === BLANK && !error && field?.satisfiedBy) {
            value = field.satisfiedBy.map(({ key }) => read(key)).join(" · ");
          }
          return {
            label: field?.reviewLabel ?? field?.label ?? row,
            value,
            error,
          };
        });
        const parts =
          flow.id === "claude-connector"
            ? CLAUDE_SUMMARIES[section.id]?.(read, values)
            : undefined;
        const summary =
          (parts ?? rows.map((row) => row.value))
            .filter((part) => part && part !== BLANK)
            .join(" · ") || BLANK;
        return (
          <ReviewSection
            key={section.id}
            section={section}
            rows={rows}
            summary={summary}
            results={openResults.filter(
              (entry) => home.get(entry.step) === section.id,
            )}
            onEdit={() => onEdit(section.edit)}
          />
        );
      })}
    </div>
  );
}

/** Every answer, step by step in the portal's words, to paste into its form. */
export function portalText(flow: DirectoryFlow, values: AnswerValues): string {
  return flow.steps
    .flatMap((step) => {
      const lines = step.fields.flatMap((field) => {
        const shown = answerText(field, values[field.key]);
        return shown === BLANK ? [] : [`${field.label}: ${shown}`];
      });
      return lines.length > 0 ? [[step.title, ...lines].join("\n")] : [];
    })
    .join("\n\n");
}

/** Where the portal has "Submit for review": MCPJam does not submit. */
export function CopyForPortal({ text }: { text: () => string }) {
  const copy = async () => {
    if (await copyToClipboard(text())) {
      toast.success("Answers copied. Paste them into the real portal.");
    } else {
      toast.error(
        "Your answers were not copied. Copy them from the rows on this page.",
      );
    }
  };
  return (
    <Button type="button" onClick={() => void copy()}>
      <Copy aria-hidden="true" />
      Copy for the portal
    </Button>
  );
}
