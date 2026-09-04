/**
 * A suite's settings history: one row per committed edit, newest first.
 *
 * THE PROBLEM THIS SOLVES. Every save has recorded a numbered revision since
 * the draft-and-commit sheet shipped — who made it, what it changed, the note
 * they left, and how many runs are pinned to it. None of that was readable
 * anywhere. "Who turned the judge off, and when?" was a question the product
 * had already answered and never showed.
 *
 * TWO RULES SHAPE THE RENDERING.
 *
 * `changedFields` are STORAGE keys, and this list translates them through the
 * settings manifest — a reader who saw "defaultPredicates" would have to know
 * the schema to connect it to the Checks row they edited. A key with no
 * manifest entry renders raw rather than being dropped: an unnamed change is
 * still a change, and hiding it would make a revision look emptier than it was.
 *
 * The list carries NO SNAPSHOTS. A page of 25 whole suite configurations is a
 * large payload for a list nobody reads that way, so the before/after diff
 * fetches the one revision it is showing.
 */

import { useMemo, useState } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import { Button } from "@mcpjam/design-system/button";
import { formatRelativeTime } from "./helpers";
import {
  EVAL_SUITE_SETTINGS_MANIFEST,
  type EvalSuiteSettingKey,
} from "@/shared/eval-suite-settings-manifest";

/** Where a revision came from. `unattributed` is a write nothing claimed. */
export const REVISION_SOURCE_LABELS: Record<string, string> = {
  ui: "App",
  api: "API",
  cli: "CLI",
  file_sync: "File sync",
  import: "Import",
  system: "System",
  unattributed: "Automated",
};

/**
 * Manifest key → the label the settings page shows for that row.
 *
 * Read from the manifest rather than copied out of it, so a row renamed on the
 * settings page is renamed here in the same edit.
 */
const MANIFEST_LABELS: Record<string, string> = Object.fromEntries(
  EVAL_SUITE_SETTINGS_MANIFEST.map((row) => [row.key, row.label]),
);

/**
 * Storage key → manifest key, for the keys whose two spellings differ.
 *
 * A snapshot key that is ALREADY a manifest key (`name`, `judgeRubric`, …)
 * needs no entry. The value type is the manifest's key union, so an alias to a
 * row that no longer exists is a type error rather than a raw key on screen.
 */
const SNAPSHOT_KEY_TO_MANIFEST_KEY: Record<string, EvalSuiteSettingKey> = {
  defaultPassCriteria: "minimumAccuracy",
  minIterations: "minimumIterations",
  defaultMatchOptions: "matchOptions",
  defaultPredicates: "checks",
  judgeConfig: "judge",
  verdictPolicyVersion: "policy",
  environment: "computerEnvironment",
  environmentIds: "environments",
};

/**
 * Storage keys with NO settings row to borrow a label from.
 *
 * Each is stored on the suite and can appear in `changedFields`, but is
 * written from somewhere other than the settings sheet — the suite header
 * (`description`, `tags`), the host and skill pickers (`hostConfigId`,
 * `serverAttachmentId`, `namedHostId`, `hostAttachments`,
 * `selectedSkillIds`), the environment resolver (`environmentFingerprints`),
 * or the policy upgrade and rollout machinery (`verdictPolicyDefaults`,
 * `verdictPolicyRolloutMode`, `gradingEngine`). The manifest's `repetitions`,
 * `passThreshold` and `validity` rows all edit `verdictPolicyDefaults`, so it
 * gets one label of its own rather than three. Add a row to the manifest and
 * an alias above before adding here.
 */
const UNLISTED_FIELD_LABELS: Record<string, string> = {
  description: "Description",
  verdictPolicyDefaults: "Policy defaults",
  verdictPolicyRolloutMode: "Policy rollout",
  gradingEngine: "Grading engine",
  environmentFingerprints: "Environment fingerprints",
  hostConfigId: "Execution config",
  serverAttachmentId: "Server attachment",
  namedHostId: "Host",
  hostAttachments: "Hosts",
  selectedSkillIds: "Skills",
  tags: "Tags",
};

export function fieldLabel(key: string): string {
  const manifestKey = SNAPSHOT_KEY_TO_MANIFEST_KEY[key] ?? key;
  return MANIFEST_LABELS[manifestKey] ?? UNLISTED_FIELD_LABELS[key] ?? key;
}

type RevisionRow = {
  _id: string;
  revisionNumber: number;
  source: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: number;
  note: string | null;
  changedFields: string[];
  revisionGroupId: string | null;
  configRevisionHashAfter: string | null;
  pinnedRunCount: number;
  pinnedRunCountCapped: boolean;
};

type RevisionDetail = {
  beforeSnapshot?: Record<string, unknown>;
  afterSnapshot?: Record<string, unknown>;
};

/** JSON a person can read, without pretending a nested object is one line. */
function renderValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "cleared";
  if (typeof value === "string") return value.length === 0 ? '""' : value;
  return JSON.stringify(value, null, 2);
}

/**
 * The keys that actually MOVED between two snapshots.
 *
 * Derived rather than trusting `changedFields`: the two are written by the same
 * transaction, but a diff that lists a key whose value is identical on both
 * sides asks a reader to look for a difference that is not there.
 */
function differingKeys(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string[] {
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  return [...keys]
    .filter(
      (key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]),
    )
    .sort();
}

function RevisionDiff({ revisionId }: { revisionId: string }) {
  const detail = useQuery(
    "testSuites:getSuiteRevision" as never,
    {
      revisionId,
    } as never,
  ) as RevisionDetail | null | undefined;

  if (detail === undefined) {
    return <p className="text-[11px] text-muted-foreground">Loading…</p>;
  }
  if (detail === null) {
    return (
      <p className="text-[11px] text-muted-foreground">
        This revision is no longer available.
      </p>
    );
  }
  const keys = differingKeys(detail.beforeSnapshot, detail.afterSnapshot);
  if (keys.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        No stored settings differ between these snapshots.
      </p>
    );
  }
  return (
    <dl className="space-y-2">
      {keys.map((key) => (
        <div key={key} className="rounded-md border border-border/60 p-2">
          <dt className="text-[11px] font-medium text-foreground">
            {fieldLabel(key)}
          </dt>
          <dd className="mt-1 grid gap-1 sm:grid-cols-2">
            <pre className="overflow-x-auto rounded bg-muted/40 p-1.5 text-[10px] text-muted-foreground">
              {renderValue(detail.beforeSnapshot?.[key])}
            </pre>
            <pre className="overflow-x-auto rounded bg-muted/40 p-1.5 text-[10px] text-foreground">
              {renderValue(detail.afterSnapshot?.[key])}
            </pre>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The list itself, mounted only while the panel is OPEN.
 *
 * Split out for that reason alone: `usePaginatedQuery` subscribes for as long
 * as it is mounted, and the panel's host lives on every suite page in edit
 * mode. Keeping the query in the always-mounted wrapper would have every
 * settings visit hold a live subscription to a history nobody asked to see.
 * Radix does not mount `SheetContent` while closed, so rendering the query in
 * here is what makes the subscription follow the panel.
 */
function RevisionList({
  suiteId,
  onCompareLatestRun,
}: {
  suiteId: string;
  onCompareLatestRun?: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { results, status, loadMore } = usePaginatedQuery(
    "testSuites:listSuiteRevisions" as never,
    { suiteId } as never,
    { initialNumItems: 25 },
  );
  const rows = results as unknown as RevisionRow[];
  const isDone = status === "Exhausted";
  const isLoading = status === "LoadingFirstPage";

  const body = useMemo(
    () =>
      rows.map((row) => {
        const isExpanded = expandedId === row._id;
        return (
          <li
            key={row._id}
            className="border-b border-border/50 py-2 last:border-b-0"
            data-revision-number={row.revisionNumber}
          >
            <button
              type="button"
              className="w-full text-left"
              onClick={() => setExpandedId(isExpanded ? null : row._id)}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-medium text-foreground">
                  r{row.revisionNumber}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {formatRelativeTime(row.createdAt)}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                {/* `createdByName` is null in two cases that must not read
                    the same. A write with an author who has since left the
                    organization keeps its `createdBy` and loses the name; a
                    write nobody is attributed for — a scheduled job, a system
                    migration — has neither. Calling the first "System" would
                    hide that a person made the change. */}
                <span>
                  {row.createdByName ??
                    (row.createdBy ? "A former member" : "System")}
                </span>
                <span aria-hidden>·</span>
                <span>{REVISION_SOURCE_LABELS[row.source] ?? row.source}</span>
                <span aria-hidden>·</span>
                <span>
                  {row.pinnedRunCount}
                  {row.pinnedRunCountCapped ? "+" : ""} runs
                </span>
              </div>
              {row.changedFields.length > 0 ? (
                <p className="mt-0.5 text-[11px] text-foreground/80">
                  {row.changedFields.map(fieldLabel).join(", ")}
                </p>
              ) : null}
              {row.note ? (
                <p className="mt-0.5 text-[11px] italic text-muted-foreground">
                  “{row.note}”
                </p>
              ) : null}
            </button>
            {isExpanded ? (
              <div className="mt-2">
                <RevisionDiff revisionId={row._id} />
              </div>
            ) : null}
          </li>
        );
      }),
    [rows, expandedId],
  );

  return (
    <>
      <div className="mt-4 max-h-[calc(100vh-12rem)] overflow-y-auto pr-1">
        {isLoading ? (
          <p className="text-[11px] text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No saved changes yet.
          </p>
        ) : (
          <ul>{body}</ul>
        )}
        {!isDone && rows.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2 h-7 text-xs"
            onClick={() => loadMore(25)}
          >
            Load more
          </Button>
        ) : null}
      </div>
      {onCompareLatestRun ? (
        <div className="mt-3 border-t border-border/60 pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={onCompareLatestRun}
          >
            Compare with run
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function SuiteRevisionHistory({
  suiteId,
  open,
  onOpenChange,
  onCompareLatestRun,
}: {
  suiteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent when the suite has no run to compare against. */
  onCompareLatestRun?: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Settings history</SheetTitle>
          <SheetDescription>
            One entry per saved change. Pinned runs were launched against that
            revision.
          </SheetDescription>
        </SheetHeader>
        <RevisionList
          suiteId={suiteId}
          onCompareLatestRun={onCompareLatestRun}
        />
      </SheetContent>
    </Sheet>
  );
}
