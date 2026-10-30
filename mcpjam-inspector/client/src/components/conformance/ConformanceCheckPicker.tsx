/**
 * Picking which checks a run covers: a checkbox per suite and per check. Run's
 * setup steps and a server's Conformance Settings both use it.
 *
 * A suite list left `undefined` means the whole suite, so a check added to the
 * suite later is picked without anyone opting in. OAuth runs as one sign-in
 * flow, so its checks follow the suite's checkbox.
 */

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import type {
  ConformanceSelection,
  ProtocolVersionPin,
} from "@/hooks/use-conformance-run";
import { cn } from "@/lib/utils";
import { CatalogList, type CatalogEntry } from "./ConformanceCheckRows";
import {
  APPS_CATALOG,
  OAUTH_CATALOG,
  TASKS_CATALOG,
  protocolCatalog,
} from "./conformance-catalogs";
import { Collapse, SUITE_COPY } from "./conformance-ui";

export type CheckSuite = "protocol" | "apps" | "tasks";

const CHECK_SUITES = ["protocol", "apps", "tasks"] as const;

export function checkCatalogs(
  versionPin: ProtocolVersionPin,
): Record<CheckSuite, CatalogEntry[]> {
  return {
    protocol: protocolCatalog(versionPin),
    apps: APPS_CATALOG,
    tasks: TASKS_CATALOG,
  };
}

function pickedIds(
  selection: ConformanceSelection,
  suite: CheckSuite,
  catalog: CatalogEntry[],
): Set<string> {
  const picked = selection[suite] as readonly string[] | undefined;
  const ids = catalog.map((entry) => entry.id);
  return new Set(
    picked === undefined ? ids : ids.filter((id) => picked.includes(id)),
  );
}

/** The selection with `ids` picked or left out of one suite. */
export function withPicked(
  selection: ConformanceSelection,
  suite: CheckSuite,
  catalog: CatalogEntry[],
  ids: string[],
  picked: boolean,
): ConformanceSelection {
  const next = pickedIds(selection, suite, catalog);
  for (const id of ids) {
    if (picked) next.add(id);
    else next.delete(id);
  }
  // Everything picked goes back to "the whole suite".
  const whole = next.size === catalog.length;
  return {
    ...selection,
    [suite]: whole
      ? undefined
      : catalog.map((entry) => entry.id).filter((id) => next.has(id)),
  };
}

export function pickedCount(
  selection: ConformanceSelection,
  suite: CheckSuite,
  catalog: CatalogEntry[],
): number {
  return pickedIds(selection, suite, catalog).size;
}

/** Nothing would run: every suite left out. */
export function nothingPicked(
  selection: ConformanceSelection,
  catalogs: Record<CheckSuite, CatalogEntry[]>,
): boolean {
  return (
    selection.oauth === false &&
    CHECK_SUITES.every(
      (suite) => pickedCount(selection, suite, catalogs[suite]) === 0,
    )
  );
}

export function ConformanceCheckPicker({
  versionPin,
  selection,
  onChange,
  countLabel = (picked) => `${picked} checks selected`,
  defaultOpen = false,
}: {
  versionPin: ProtocolVersionPin;
  selection: ConformanceSelection;
  onChange: (selection: ConformanceSelection) => void;
  countLabel?: (picked: number, total: number) => string;
  defaultOpen?: boolean;
}) {
  const catalogs = checkCatalogs(versionPin);
  const runOAuth = selection.oauth !== false;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {CHECK_SUITES.map((suite) => {
        const catalog = catalogs[suite];
        const picked = pickedIds(selection, suite, catalog);
        return (
          <SuiteChecks
            key={suite}
            title={SUITE_COPY[suite].title}
            description={SUITE_COPY[suite].description}
            catalog={catalog}
            pickedCount={picked.size}
            countLabel={countLabel}
            defaultOpen={defaultOpen}
            onSuiteChange={(value) =>
              onChange(
                withPicked(
                  selection,
                  suite,
                  catalog,
                  catalog.map((entry) => entry.id),
                  value,
                ),
              )
            }
            isPicked={(id) => picked.has(id)}
            onCheckChange={(id, value) =>
              onChange(withPicked(selection, suite, catalog, [id], value))
            }
          />
        );
      })}
      <SuiteChecks
        title={SUITE_COPY.oauth.title}
        description={SUITE_COPY.oauth.description}
        catalog={OAUTH_CATALOG}
        pickedCount={runOAuth ? OAUTH_CATALOG.length : 0}
        countLabel={countLabel}
        defaultOpen={defaultOpen}
        onSuiteChange={(value) => onChange({ ...selection, oauth: value })}
        // Shown, but locked to the suite's checkbox.
        isPicked={() => runOAuth}
        listNote=". They run together as one sign-in flow."
      />
    </div>
  );
}

/**
 * One suite: a checkbox for the whole suite, its picked count, and the checks
 * it runs. With `isPicked`, each check shows a checkbox, which the user can
 * change only when `onCheckChange` is set.
 */
function SuiteChecks({
  title,
  description,
  catalog,
  pickedCount,
  countLabel,
  defaultOpen,
  onSuiteChange,
  isPicked,
  onCheckChange,
  listNote = ".",
}: {
  title: string;
  description: string;
  catalog: CatalogEntry[];
  pickedCount: number;
  countLabel: (picked: number, total: number) => string;
  defaultOpen: boolean;
  onSuiteChange: (picked: boolean) => void;
  isPicked?: (id: string) => boolean;
  onCheckChange?: (id: string, picked: boolean) => void;
  listNote?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const checked =
    pickedCount === 0
      ? false
      : pickedCount === catalog.length
        ? true
        : "indeterminate";
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex items-start gap-3 p-4 transition-colors hover:bg-muted/30">
        <Checkbox
          checked={checked}
          onCheckedChange={() => onSuiteChange(checked !== true)}
          aria-label={`Run ${title}`}
          className="mt-0.5"
        />
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 grow items-start gap-3 text-left"
        >
          <span className="flex min-w-0 grow flex-col gap-0.5">
            <span className="text-sm font-semibold">{title}</span>
            <span className="text-sm text-muted-foreground">{description}</span>
          </span>
          <span className="shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
            {countLabel(pickedCount, catalog.length)}
          </span>
          <ChevronRight
            className={cn(
              "mt-0.5 size-4 shrink-0 transition-transform duration-300 ease-out motion-reduce:transition-none",
              open ? "rotate-90 text-foreground" : "text-muted-foreground",
            )}
          />
        </button>
      </div>
      <Collapse open={open}>
        <div className="border-t border-border/60 px-4">
          <CatalogList
            catalog={catalog}
            note={listNote}
            isSelected={isPicked}
            onSelectedChange={onCheckChange}
          />
        </div>
      </Collapse>
    </div>
  );
}
