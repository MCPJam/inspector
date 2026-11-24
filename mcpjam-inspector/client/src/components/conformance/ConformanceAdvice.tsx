/**
 * Every suite's SHOULD/MAY advice in one container above the suites: the spec
 * words are explained once in its header, and each row says how strong the
 * advice is, which suite it came from, and what to change. Advice the server
 * already meets is listed after it, in green with a check. Closed by default
 * with a count, so the first thing a run shows is its score, not a long list.
 */
import { useState } from "react";
import { Check, ChevronRight, Info } from "lucide-react";
import {
  APPS_READINESS_CATALOG,
  OAUTH_READINESS_CATALOG,
  READINESS_CATALOG,
  TASKS_READINESS_CATALOG,
} from "@mcpjam/sdk/browser";
import { cn } from "@/lib/utils";
import { Collapse, StatusIcon, SUITE_COPY } from "./conformance-ui";

export interface AdviceItem {
  id: string;
  title: string;
  specStrength: string;
  message: string;
}

/** Advice the run checked and the server already meets. */
export interface PassedAdviceItem {
  id: string;
  title: string;
  specStrength: string;
}

/** One suite's advice, as its result reports it. */
export interface AdviceGroup {
  suite: string;
  readiness?: readonly AdviceItem[];
  passed?: readonly PassedAdviceItem[];
}

const ADVICE_SUITES = ["protocol", "apps", "tasks", "oauth"] as const;

/** A suite's run state, read only for the advice its result carries. */
interface AdviceSource {
  result?: {
    readiness?: readonly AdviceItem[];
    passedAdvice?: readonly PassedAdviceItem[];
  } | null;
}

/** One group per suite, in the order the panel lists the suites. */
export function suiteAdviceGroups(
  runs: Record<(typeof ADVICE_SUITES)[number], AdviceSource>,
): AdviceGroup[] {
  return ADVICE_SUITES.map((suite) => ({
    suite: SUITE_COPY[suite].title,
    readiness: runs[suite].result?.readiness,
    passed: runs[suite].result?.passedAdvice,
  }));
}

/** One advisory as a saved suite report stores it. */
interface SavedReportAdvisory {
  id?: unknown;
  title?: unknown;
  kind?: unknown;
  status?: unknown;
  message?: unknown;
}

/** Saved entries, as objects: a shared report can be anything. */
function savedEntries(value: unknown): SavedReportAdvisory[] {
  return (Array.isArray(value) ? value : []).map(
    (entry: unknown) => (entry ?? {}) as SavedReportAdvisory,
  );
}

/**
 * One group per saved suite report, from the advice the report saved. Reports
 * from before advice was saved have none, so their suites add nothing; the
 * same goes for passes on reports saved before passes were.
 */
export function reportAdviceGroups(
  reports: ReadonlyArray<{
    suiteKind: string;
    /** Read as saved, so it is checked here: a shared report can be anything. */
    advisories?: unknown;
    /** The report's `passedAdvisories`, checked the same way. */
    passedAdvisories?: unknown;
  }>,
): AdviceGroup[] {
  return reports.map(({ suiteKind, advisories, passedAdvisories }) => {
    const passed = savedEntries(passedAdvisories).flatMap((advisory) =>
      typeof advisory.id === "string" &&
      typeof advisory.title === "string" &&
      typeof advisory.status === "string"
        ? [
            {
              id: advisory.id,
              title: advisory.title,
              specStrength: advisory.status,
            },
          ]
        : [],
    );
    return {
      suite:
        SUITE_COPY[suiteKind as keyof typeof SUITE_COPY]?.title ?? suiteKind,
      readiness: savedEntries(advisories).flatMap((advisory) =>
        advisory.kind === "readiness" &&
        typeof advisory.id === "string" &&
        typeof advisory.title === "string" &&
        typeof advisory.status === "string"
          ? [
              {
                id: advisory.id,
                title: advisory.title,
                specStrength:
                  suiteKind === "protocol" &&
                  advisory.id === "readiness-deprecated-feature-use" &&
                  advisory.status === "SHOULD"
                    ? "Deprecation Notice"
                    : advisory.status,
                message:
                  typeof advisory.message === "string" ? advisory.message : "",
              },
            ]
          : [],
      ),
      ...(passed.length > 0 ? { passed } : {}),
    };
  });
}

/** RFC 2119 defines each requirement word in its own section. */
const RFC_2119_URLS = {
  SHOULD: "https://www.rfc-editor.org/info/rfc2119/#section-3",
  MAY: "https://www.rfc-editor.org/info/rfc2119/#section-5",
};

function SpecWord({ word }: { word: keyof typeof RFC_2119_URLS }) {
  return (
    <a
      href={RFC_2119_URLS[word]}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {word}
    </a>
  );
}

/** MAY is optional; SHOULD is what the spec asks for. */
function isOptional(item: { specStrength: string }): boolean {
  return item.specStrength === "MAY";
}

/**
 * "Suggested (SHOULD)", "Optional (MAY)". A deprecation asks for a change
 * like a SHOULD, but the spec states no SHOULD for it, so its parentheses say
 * why it is suggested instead of naming a spec word.
 */
function strengthLabel(specStrength: string): string {
  if (specStrength === "Deprecation Notice") return "Suggested (Deprecated)";
  return `${specStrength === "MAY" ? "Optional" : "Suggested"} (${specStrength})`;
}

/**
 * What each advice asks for, for a passed row that carries no message. A Map,
 * not an object: ids come from saved reports, and `"__proto__"` must find
 * nothing rather than the prototype.
 */
const ADVICE_DESCRIPTIONS = new Map<string, string>(
  [
    READINESS_CATALOG,
    APPS_READINESS_CATALOG,
    TASKS_READINESS_CATALOG,
    OAUTH_READINESS_CATALOG,
  ].flatMap((catalog) =>
    Object.entries(catalog).map(([id, entry]) => [id, entry.description]),
  ),
);

/** Suggested before Optional, each in suite order. */
function bySuggestedFirst<T extends { specStrength: string }>(
  a: T,
  b: T,
): number {
  return Number(isOptional(a)) - Number(isOptional(b));
}

function AdviceRow({
  label,
  suite,
  title,
  detail,
  passed,
}: {
  label: string;
  suite: string;
  title: string;
  detail?: string;
  passed: boolean;
}) {
  return (
    <li
      // Indented like a suite's check rows (`pl-7`), so the icon sits
      // under the header's text rather than its chevron.
      className="flex items-start gap-2.5 border-b border-border/60 py-2.5 pl-7 last:border-0"
    >
      {passed ? (
        <span className="mt-0.5">
          <StatusIcon status="passed" />
        </span>
      ) : (
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" />
      )}
      <span className="flex min-w-0 flex-col gap-0.5 text-sm">
        <span>
          <span
            className={cn(
              "font-medium",
              passed ? "text-emerald-700 dark:text-emerald-400" : "text-info",
            )}
          >
            {label}
          </span>{" "}
          <span className="text-muted-foreground">{suite}</span>{" "}
          <span className="font-medium">{title}</span>
        </span>
        {detail ? (
          <span className="text-muted-foreground">{detail}</span>
        ) : null}
      </span>
    </li>
  );
}

export function ConformanceAdvice({ groups }: { groups: AdviceGroup[] }) {
  const [open, setOpen] = useState(false);
  const items = groups
    .flatMap((group) =>
      (group.readiness ?? []).map((item) => ({ ...item, suite: group.suite })),
    )
    .sort(bySuggestedFirst);
  const passed = groups
    .flatMap((group) =>
      (group.passed ?? []).map((item) => ({ ...item, suite: group.suite })),
    )
    .sort(bySuggestedFirst);
  if (items.length === 0 && passed.length === 0) return null;

  return (
    <section className="mt-3 overflow-hidden rounded-lg border border-border bg-popover">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 pt-4 pb-1 text-left transition-colors hover:bg-muted/30"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 transition-transform duration-300 ease-out motion-reduce:transition-none",
            open ? "rotate-90 text-foreground" : "text-muted-foreground",
          )}
        />
        <span className="text-sm font-semibold">Additional enhancements</span>
        {items.length > 0 ? (
          <span className="rounded-full bg-info/10 px-1.5 py-px text-xs font-medium tabular-nums text-info">
            {items.length}
          </span>
        ) : null}
        {passed.length > 0 ? (
          <span className="-ml-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-px text-xs font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
            <Check aria-hidden="true" className="size-3" strokeWidth={3} />
            {passed.length} passed
          </span>
        ) : null}
      </button>
      {/* Outside the toggle: a link can't sit inside a button. */}
      <p className="px-4 pb-4 pl-11 text-sm text-muted-foreground">
        None of these fail a check. Suggested (<SpecWord word="SHOULD" />) means
        the spec asks for it. Optional (<SpecWord word="MAY" />) means it helps
        but the spec doesn't require it.
      </p>
      <Collapse open={open}>
        <ul className="border-t border-border/60 px-4">
          {items.map((item) => (
            <AdviceRow
              key={`${item.suite}-${item.id}`}
              label={strengthLabel(item.specStrength)}
              suite={item.suite}
              title={item.title}
              detail={item.message}
              passed={false}
            />
          ))}
          {passed.map((item) => (
            <AdviceRow
              key={`${item.suite}-${item.id}-passed`}
              label={strengthLabel(item.specStrength)}
              suite={item.suite}
              title={item.title}
              detail={ADVICE_DESCRIPTIONS.get(item.id)}
              passed
            />
          ))}
        </ul>
      </Collapse>
    </section>
  );
}
