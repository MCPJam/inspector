/**
 * One check's evidence, opened from its result: what it read, whether that
 * evidence still holds, the run that reached it, the rule it cites, the next
 * step, and the observation stored with it. The drawer is MCPJam's own, so it
 * opens beside the copied portal in MCPJam's colours.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import {
  directoryFlowField,
  directoryPlacementOf,
  type DirectoryFlow,
  type PlacedFinding,
} from "@mcpjam/sdk/browser";
import { Badge } from "@mcpjam/design-system/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import { JsonEditor } from "@/components/ui/json-editor";
import {
  getSubmissionFinding,
  type StoredFinding,
  type SubmissionScope,
} from "@/lib/apis/directory-submissions-api";
import { sentenceOf } from "./error-sentence";
import { evidenceNote, EvidenceStatusBadge } from "./EvidenceStatus";
import { McpjamMark, severityOf, SOURCE } from "./McpjamChecks";

/** What a check reads besides answers: the flow's needs, the stored inputs. */
const ALSO: Record<string, string> = {
  server: "Your server",
  catalog: "The tools your server listed",
  reviewer: "The reviewer account",
  model: "A model's reading",
  package: "Your package",
};

const DAY = { month: "short", day: "numeric", year: "numeric" } as const;

type Details =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "done"; stored: StoredFinding };

/** The rule a finding cites, from whichever shape its directory uses. */
function citationOf(source: unknown) {
  const ref =
    source && typeof source === "object"
      ? (source as Record<string, unknown>)
      : {};
  const text = (key: string) =>
    typeof ref[key] === "string" ? (ref[key] as string) : undefined;
  const url = text("url");
  if (!url) return undefined;
  const read = text("snapshotDate");
  return {
    url,
    label: text("section") ?? text("title") ?? url,
    // A page MCPJam listed but never read has no revision.
    note:
      ref.revision === null
        ? "MCPJam has not confirmed this page's text."
        : read &&
          `Page as read on ${new Date(read).toLocaleDateString("en-US", { ...DAY, timeZone: "UTC" })}.`,
  };
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 border-t border-border py-2.5 text-sm first:border-t-0">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function EvidenceDrawer({
  flow,
  scope,
  resultsRunId,
  entry,
  onClose,
}: {
  flow: DirectoryFlow;
  scope: SubmissionScope;
  /** The run whose results the page shows. */
  resultsRunId: string | null;
  entry: PlacedFinding;
  onClose: () => void;
}) {
  const { finding, evidenceStatus } = entry;
  const { projectId, submissionId } = scope;
  const [details, setDetails] = useState<Details>({ state: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setDetails({ state: "loading" });
    getSubmissionFinding(
      { projectId, submissionId },
      finding.id,
      controller.signal,
    ).then(
      (stored) => {
        if (!controller.signal.aborted) setDetails({ state: "done", stored });
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setDetails({ state: "error", message: sentenceOf(failure) });
      },
    );
    return () => controller.abort();
  }, [projectId, submissionId, finding.id]);

  const stored = details.state === "done" ? details.stored : undefined;
  const placement = directoryPlacementOf(flow, finding.id);
  const label = (key: string) => directoryFlowField(flow, key)?.label ?? key;
  // The stored inputs are what this result read; the flow says what it reads.
  const inputs = stored?.inputs;
  const answers = inputs
    ? inputs.filter((input) => input.kind === "answer").map(({ key }) => key)
    : (placement?.reads ?? []);
  const also = [
    ...new Set([
      ...(inputs ?? [])
        .filter((input) => input.kind !== "answer")
        .map(({ kind }) => kind),
      ...(placement?.needs ?? []),
    ]),
  ].map((kind) => ALSO[kind] ?? kind);
  const runId = stored?.runId ?? resultsRunId;
  const at = stored?.evaluatedAt ?? Date.parse(finding.evaluatedAt);
  const rule = citationOf(finding.source);
  const severity = severityOf(entry).label;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader className="border-b border-border pr-10">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <McpjamMark />
            Evidence for one check
          </p>
          <SheetTitle>{finding.title}</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-1.5">
            {severity ? <Badge variant="outline">{severity}</Badge> : null}
            <EvidenceStatusBadge status={evidenceStatus} />
            {SOURCE[finding.provenance] ?? finding.provenance}
          </SheetDescription>
        </SheetHeader>
        <dl className="px-4 py-2">
          <Row term="What it read">
            {answers.length > 0 ? (
              <span className="block">
                Your answers: {answers.map(label).join(", ")}
              </span>
            ) : null}
            {also.length > 0 ? (
              <span className="block">{also.join(", ")}</span>
            ) : null}
            {answers.length + also.length === 0 ? "None of your answers" : null}
          </Row>
          <Row term="Evidence">
            {evidenceNote(entry, label) ??
              "Nothing it read has changed since the run."}
          </Row>
          <Row term="Run">
            {runId ? <code className="font-code text-xs">{runId}</code> : null}
            {Number.isFinite(at) ? (
              <span className="block">
                {new Date(at).toLocaleString("en-US", {
                  ...DAY,
                  hour: "numeric",
                  minute: "2-digit",
                })}
                {` · Engine ${finding.engineVersion}`}
              </span>
            ) : null}
            {stored && stored.runId !== resultsRunId ? (
              <span className="block text-muted-foreground">
                Stored by a different run from the one this page shows.
              </span>
            ) : null}
          </Row>
          {rule ? (
            <Row term="Rule">
              <a
                href={rule.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-ring underline underline-offset-2"
              >
                {rule.label}
                <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
              </a>
              {rule.note ? (
                <span className="block text-muted-foreground">{rule.note}</span>
              ) : null}
            </Row>
          ) : null}
          {finding.remediation ? (
            <Row term="Next step">{finding.remediation}</Row>
          ) : null}
          <Row term="Observation">
            {details.state === "loading" ? (
              <span className="text-muted-foreground">
                Loading the stored observation…
              </span>
            ) : details.state === "error" ? (
              <span role="alert" className="text-destructive">
                {`The stored observation did not load. ${details.message} Close this panel and open it again.`}
              </span>
            ) : details.stored.details === undefined ? (
              <span className="text-muted-foreground">
                No observation was stored with this result.
              </span>
            ) : (
              <>
                <JsonEditor
                  value={details.stored.details}
                  viewOnly
                  collapsible
                  defaultExpandDepth={2}
                  height="auto"
                  maxHeight={360}
                  className="rounded-md border border-border"
                />
                {details.stored.detailsTruncated ? (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Only the first 8 KB of the observation were kept.
                  </span>
                ) : null}
              </>
            )}
          </Row>
        </dl>
      </SheetContent>
    </Sheet>
  );
}
