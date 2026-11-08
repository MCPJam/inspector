/**
 * Picking which checks a run covers: a checkbox per suite and per check. Run's
 * setup steps and a server's Conformance Settings both use it.
 *
 * A suite list left `undefined` means the whole suite, so a check added to the
 * suite later is picked without anyone opting in. OAuth runs as one sign-in
 * flow, so its checks follow the suite's checkbox. The protocol suite's
 * advice (no points) can be listed under its checks and picked the same way.
 *
 * A check still missing its input shows unchecked, locked while picked. The
 * pick is kept: the run still sends it, so the result says it was not run for
 * want of input, and it runs once the input is set. A suite's box is checked
 * only with every check picked.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { copyToClipboard } from "@/lib/clipboard";
import { getDebugRedirectUrl } from "@/lib/oauth/debug-state-machine-adapter";
import type {
  ConformanceSelection,
  ProtocolVersionPin,
} from "@/hooks/use-conformance-run";
import { cn } from "@/lib/utils";
import {
  CatalogList,
  NeedsInputTag,
  type CatalogEntry,
} from "./ConformanceCheckRows";
import {
  APPS_CATALOG,
  OAUTH_ADVICE_CATALOG,
  OAUTH_CATALOG,
  TASKS_ADVICE_CATALOG,
  TASKS_CATALOG,
  protocolAdviceCatalog,
  protocolCatalog,
} from "./conformance-catalogs";
import { Collapse, SUITE_COPY } from "./conformance-ui";
import { OAUTH_CALLBACK_HINT_PREFIX } from "./oauth-callback-hint";

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

/** Each suite's advice list in the selection. Apps has no advice. */
const ADVICE_LISTS = {
  protocol: "protocolAdvice",
  tasks: "tasksAdvice",
  oauth: "oauthAdvice",
} as const;

type AdviceSuite = keyof typeof ADVICE_LISTS;

/** A list of picks in the selection: a suite's checks, or a suite's advice. */
type PickList = CheckSuite | (typeof ADVICE_LISTS)[AdviceSuite];

/** Each suite's advice, the protocol list narrowed by a pin like its checks. */
export function adviceCatalogs(
  versionPin: ProtocolVersionPin,
): Record<AdviceSuite, CatalogEntry[]> {
  return {
    protocol: protocolAdviceCatalog(versionPin),
    tasks: TASKS_ADVICE_CATALOG,
    oauth: OAUTH_ADVICE_CATALOG,
  };
}

function adviceSuiteOf(list: PickList): AdviceSuite | undefined {
  return (Object.keys(ADVICE_LISTS) as AdviceSuite[]).find(
    (suite) => ADVICE_LISTS[suite] === list,
  );
}

function pickedIds(
  selection: ConformanceSelection,
  suite: PickList,
  catalog: CatalogEntry[],
): Set<string> {
  const picked = selection[suite] as readonly string[] | undefined;
  const ids = catalog.map((entry) => entry.id);
  return new Set(
    picked === undefined ? ids : ids.filter((id) => picked.includes(id)),
  );
}

/** The selection with `ids` picked or left out of one suite, or the advice. */
export function withPicked(
  selection: ConformanceSelection,
  suite: PickList,
  catalog: CatalogEntry[],
  ids: string[],
  picked: boolean,
): ConformanceSelection {
  const next = pickedIds(selection, suite, catalog);
  for (const id of ids) {
    if (picked) next.add(id);
    else next.delete(id);
  }
  // A version pin shows only its own checks; the ones it hides keep their
  // pick, or a change here would drop them from the saved defaults.
  const shown = new Set(catalog.map((entry) => entry.id));
  const stored = selection[suite] as readonly string[] | undefined;
  const adviceSuite = adviceSuiteOf(suite);
  const all = (
    adviceSuite
      ? adviceCatalogs("auto")[adviceSuite]
      : checkCatalogs("auto")[suite as CheckSuite]
  ).map((entry) => entry.id);
  const kept = all.filter((id) =>
    shown.has(id) ? next.has(id) : stored === undefined || stored.includes(id),
  );
  // Everything picked goes back to "the whole suite".
  return {
    ...selection,
    [suite]: kept.length === all.length ? undefined : kept,
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

/**
 * OAuth's checks are steps of one sign-in flow, so they cannot be run one by
 * one: the suite's checkbox decides whether the flow runs, and a check's box
 * decides whether it COUNTS. An unchecked check still runs and reads as
 * unscored (`oauthUnscored`).
 */
function isOAuthStepScored(selection: ConformanceSelection, id: string) {
  return (
    selection.oauth !== false && !(selection.oauthUnscored ?? []).includes(id)
  );
}

/** The suite's box: run the flow with every check counting, or not at all. */
export function withOAuthSuite(
  selection: ConformanceSelection,
  run: boolean,
): ConformanceSelection {
  const next: ConformanceSelection = { ...selection, oauth: run };
  delete next.oauthUnscored;
  return next;
}

/** One check's box: whether it counts toward the score. */
export function withOAuthStep(
  selection: ConformanceSelection,
  id: string,
  scored: boolean,
): ConformanceSelection {
  // Checking a box while the flow is off turns it on with only that check
  // counting, as the other suites' rows do.
  const unscored = new Set(
    selection.oauth === false
      ? OAUTH_CATALOG.map((entry) => entry.id)
      : (selection.oauthUnscored ?? []),
  );
  if (scored) unscored.delete(id);
  else unscored.add(id);
  // Nothing left counting: the flow would run for no score, so leave it out.
  if (OAUTH_CATALOG.every((entry) => unscored.has(entry.id))) {
    return withOAuthSuite(selection, false);
  }
  const next: ConformanceSelection = { ...selection, oauth: true };
  if (unscored.size > 0) next.oauthUnscored = [...unscored];
  else delete next.oauthUnscored;
  return next;
}

export function ConformanceCheckPicker({
  versionPin,
  selection,
  onChange,
  countLabel = (picked, total) => `${picked}/${total} checks selected`,
  defaultOpen = false,
  showAdvice = false,
  renderCheckExtra,
  renderSuiteExtra,
  checkInputStatus,
  checkNotApplicable,
}: {
  versionPin: ProtocolVersionPin;
  selection: ConformanceSelection;
  onChange: (selection: ConformanceSelection) => void;
  countLabel?: (picked: number, total: number) => string;
  defaultOpen?: boolean;
  /**
   * List each suite's advice under its checks, to pick like them. Off in
   * Conformance Settings: the saved defaults hold check lists only.
   */
  showAdvice?: boolean;
  /**
   * What a check or advice shows under it: the tool it calls, for the ones
   * that must call one. Given its suite, whether each in that suite is
   * picked, and their titles.
   */
  renderCheckExtra?: (
    suite: CheckSuite,
    checkId: string,
    isPicked: (id: string) => boolean,
    checkTitle: (id: string) => string | undefined,
  ) => ReactNode;
  renderSuiteExtra?: (suite: CheckSuite) => ReactNode;
  /** Whether a check that needs an input (a tool to call) has it. */
  checkInputStatus?: (
    suite: CheckSuite,
    checkId: string,
  ) => "missing" | "set" | undefined;
  /**
   * Why a check has nothing to test on this server, if so. The row is shaded
   * with the reason as a tooltip; it stays picked, so it runs once it applies.
   */
  checkNotApplicable?: (
    suite: CheckSuite,
    checkId: string,
  ) => string | undefined;
}) {
  const catalogs = checkCatalogs(versionPin);
  const advice = adviceCatalogs(versionPin);
  const adviceCatalog = (suite: AdviceSuite) =>
    showAdvice ? advice[suite] : [];
  // Advice runs only with its suite, so while the suite runs nothing, none
  // of it is picked or can be.
  const adviceSection = (suite: AdviceSuite, suiteRuns: boolean) => {
    const catalog = adviceCatalog(suite);
    const list = ADVICE_LISTS[suite];
    const picked = suiteRuns
      ? pickedIds(selection, list, catalog)
      : new Set<string>();
    return {
      catalog,
      picked,
      prop:
        catalog.length > 0
          ? {
              catalog,
              isPicked: (id: string) => picked.has(id),
              onChange: suiteRuns
                ? (id: string, value: boolean) =>
                    onChange(withPicked(selection, list, catalog, [id], value))
                : undefined,
            }
          : undefined,
    };
  };
  // A suite's box covers its advice too.
  const withAllAdvice = (
    next: ConformanceSelection,
    suite: AdviceSuite,
    value: boolean,
  ) => {
    const catalog = adviceCatalog(suite);
    return catalog.length > 0
      ? withPicked(
          next,
          ADVICE_LISTS[suite],
          catalog,
          catalog.map((entry) => entry.id),
          value,
        )
      : next;
  };
  const oauthAdvice = adviceSection("oauth", selection.oauth !== false);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {CHECK_SUITES.map((suite) => {
        const catalog = catalogs[suite];
        const picked = pickedIds(selection, suite, catalog);
        const inputStatus = checkInputStatus
          ? (checkId: string) => checkInputStatus(suite, checkId)
          : undefined;
        const adviceSuite = suite === "apps" ? undefined : suite;
        const suiteAdvice = adviceSuite
          ? adviceSection(adviceSuite, picked.size > 0)
          : undefined;
        const isPicked = (id: string) =>
          picked.has(id) || Boolean(suiteAdvice?.picked.has(id));
        const titleOf = (id: string) =>
          (
            catalog.find((item) => item.id === id) ??
            suiteAdvice?.catalog.find((item) => item.id === id)
          )?.title;
        const renderExtra = renderCheckExtra
          ? (entry: CatalogEntry) =>
              renderCheckExtra(suite, entry.id, isPicked, titleOf)
          : undefined;
        const renderTag = (entry: CatalogEntry) => {
          const status = inputStatus?.(entry.id);
          return status ? (
            <NeedsInputTag
              status={status}
              picked={isPicked(entry.id)}
              advice={Boolean(
                suiteAdvice?.catalog.some((item) => item.id === entry.id),
              )}
            />
          ) : null;
        };
        const notApplicableReason = checkNotApplicable
          ? (entry: CatalogEntry) => checkNotApplicable(suite, entry.id)
          : undefined;
        return (
          <SuiteChecks
            key={suite}
            title={SUITE_COPY[suite].title}
            description={SUITE_COPY[suite].description}
            catalog={catalog}
            countLabel={countLabel}
            defaultOpen={defaultOpen}
            onSuiteChange={(value) => {
              const next = withPicked(
                selection,
                suite,
                catalog,
                catalog.map((entry) => entry.id),
                value,
              );
              onChange(
                adviceSuite ? withAllAdvice(next, adviceSuite, value) : next,
              );
            }}
            isPicked={(id) => picked.has(id)}
            needsInput={(id) => inputStatus?.(id) === "missing"}
            onCheckChange={(id, value) =>
              onChange(withPicked(selection, suite, catalog, [id], value))
            }
            suiteExtra={renderSuiteExtra?.(suite)}
            renderExtra={renderExtra}
            renderTag={renderTag}
            notApplicableReason={notApplicableReason}
            advice={suiteAdvice?.prop}
            needsInputCount={
              catalog.filter(
                (entry) =>
                  picked.has(entry.id) && inputStatus?.(entry.id) === "missing",
              ).length
            }
          />
        );
      })}
      <SuiteChecks
        title={SUITE_COPY.oauth.title}
        description={SUITE_COPY.oauth.description}
        catalog={OAUTH_CATALOG}
        countLabel={countLabel}
        defaultOpen={defaultOpen}
        onSuiteChange={(value) =>
          onChange(
            withAllAdvice(withOAuthSuite(selection, value), "oauth", value),
          )
        }
        isPicked={(id) => isOAuthStepScored(selection, id)}
        onCheckChange={(id, value) =>
          onChange(withOAuthStep(selection, id, value))
        }
        listNote=". They run together as one sign-in flow, so an unchecked check still runs but does not count toward the score."
        headerNote={
          selection.oauth !== false ? <OAuthCallbackNote /> : undefined
        }
        advice={oauthAdvice.prop}
      />
    </div>
  );
}

/**
 * The OAuth checks sign in through their own callback URL, which an OAuth app
 * with a redirect allow list rejects inside the pop-up. Said before the run,
 * with the URL to copy.
 */
function OAuthCallbackNote() {
  const url = getDebugRedirectUrl();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <p className="text-xs text-muted-foreground">
      {OAUTH_CALLBACK_HINT_PREFIX}{" "}
      <code className="break-all font-mono text-foreground">{url}</code>{" "}
      <button
        type="button"
        aria-label="Copy callback URL"
        title="Copy callback URL"
        onClick={() => {
          copyToClipboard(url).then((ok) => {
            if (ok) setCopied(true);
          });
        }}
        className="inline-flex size-4 items-center justify-center align-middle text-muted-foreground hover:text-foreground"
      >
        {copied ? (
          <Check className="size-3 text-green-500" />
        ) : (
          <Copy className="size-3" />
        )}
      </button>{" "}
      to it before you run.
    </p>
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
  countLabel,
  defaultOpen,
  onSuiteChange,
  isPicked,
  needsInput,
  onCheckChange,
  listNote = ".",
  headerNote,
  suiteExtra,
  renderExtra,
  renderTag,
  notApplicableReason,
  needsInputCount = 0,
  advice,
}: {
  title: string;
  description: string;
  catalog: CatalogEntry[];
  countLabel: (picked: number, total: number) => string;
  defaultOpen: boolean;
  onSuiteChange: (picked: boolean) => void;
  isPicked?: (id: string) => boolean;
  /** A check or advice still missing its input, so it will not run. */
  needsInput?: (id: string) => boolean;
  onCheckChange?: (id: string, picked: boolean) => void;
  listNote?: string;
  /** A line under the header, shown while the suite is closed too. */
  headerNote?: ReactNode;
  suiteExtra?: ReactNode;
  renderExtra?: (entry: CatalogEntry) => ReactNode;
  renderTag?: (entry: CatalogEntry) => ReactNode;
  notApplicableReason?: (entry: CatalogEntry) => string | undefined;
  /**
   * Picked checks still missing an input, flagged on the closed header as
   * optional: the run goes ahead without them and they cost no points.
   */
  needsInputCount?: number;
  /** The suite's advice, listed under its checks; the suite's box covers it. */
  advice?: {
    catalog: CatalogEntry[];
    isPicked: (id: string) => boolean;
    onChange?: (id: string, picked: boolean) => void;
  };
}) {
  const [open, setOpen] = useState(defaultOpen);
  const missing = (id: string) => Boolean(needsInput?.(id));
  const picked = (id: string) => Boolean(isPicked?.(id));
  // A picked check missing its input shows unchecked and is locked until the
  // input is set. Unpicked, its box still works, so it can be opted in and
  // its tool field shown.
  const shownPicked = (isRowPicked?: (id: string) => boolean) =>
    isRowPicked && ((id: string) => isRowPicked(id) && !missing(id));
  const lockedIn = (isRowPicked?: (id: string) => boolean) => (id: string) =>
    Boolean(isRowPicked?.(id)) && missing(id);
  const pickedCount = catalog.filter(
    (entry) => picked(entry.id) && !missing(entry.id),
  ).length;
  // The box follows the count, so the two never disagree. Once every check
  // that can run is picked, a click leaves the suite out, so it is never a
  // dead click while some checks still need input.
  const checked = pickedCount === catalog.length;
  const turnsOff =
    catalog.some((entry) => picked(entry.id)) &&
    catalog.every((entry) => missing(entry.id) || picked(entry.id));
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex items-start gap-3 p-4 transition-colors hover:bg-muted/30">
        {/* A 24px target around the box: the label passes its clicks on. */}
        <label className="-m-1 flex size-6 shrink-0 cursor-pointer items-center justify-center">
          <Checkbox
            checked={checked}
            onCheckedChange={() => onSuiteChange(!turnsOff)}
            aria-label={`Run ${title}`}
          />
        </label>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 grow items-start gap-3 text-left"
        >
          <span className="flex min-w-0 grow flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{title}</span>
              {needsInputCount > 0 ? (
                <span className="rounded-sm border border-warning/50 bg-warning/10 px-1.5 py-px text-xs text-warning-foreground">
                  {needsInputCount} <em>optional</em>{" "}
                  {needsInputCount === 1
                    ? "check needs input"
                    : "checks need input"}
                </span>
              ) : null}
            </span>
            <span className="text-sm text-muted-foreground">{description}</span>
          </span>
          <span className="shrink-0 text-sm font-medium text-muted-foreground tabular-nums">
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
      {/* Outside the toggle button, so a control in it is not nested in one. */}
      {headerNote ? <div className="-mt-2 pb-4 pl-11 pr-4">{headerNote}</div> : null}
      <Collapse open={open}>
        <div className="border-t border-border/60 px-4">
          {suiteExtra}
          <CatalogList
            catalog={catalog}
            note={listNote}
            isSelected={shownPicked(isPicked)}
            isLocked={lockedIn(isPicked)}
            onSelectedChange={onCheckChange}
            renderExtra={renderExtra}
            renderTag={renderTag}
            notApplicableReason={notApplicableReason}
          />
          {advice ? (
            <div className="border-t border-border/60">
              <CatalogList
                catalog={advice.catalog}
                heading={`Advice: ${advice.catalog.length} ${
                  advice.catalog.length === 1 ? "tip" : "tips"
                }, run with the checks above.`}
                isSelected={shownPicked(advice.isPicked)}
                isLocked={lockedIn(advice.isPicked)}
                onSelectedChange={advice.onChange}
                renderExtra={renderExtra}
                renderTag={renderTag}
                notApplicableReason={notApplicableReason}
              />
            </div>
          ) : null}
        </div>
      </Collapse>
    </div>
  );
}
