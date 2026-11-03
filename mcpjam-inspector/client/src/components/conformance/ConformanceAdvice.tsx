/**
 * Every suite's SHOULD/MAY advice in one container above the suites: the spec
 * words are explained once in its header, and each row says how strong the
 * advice is, which suite it came from, and what to change. Closed by default
 * with a count, so the first thing a run shows is its score, not a long list.
 */
import { useState } from "react";
import { ChevronRight, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapse, SUITE_COPY } from "./conformance-ui";

export interface AdviceItem {
  id: string;
  title: string;
  specStrength: string;
  message: string;
}

/** One suite's advice, as its result reports it. */
export interface AdviceGroup {
  suite: string;
  readiness?: readonly AdviceItem[];
}

const ADVICE_SUITES = ["protocol", "apps", "tasks", "oauth"] as const;

/** A suite's run state, read only for the advice its result carries. */
interface AdviceSource {
  result?: { readiness?: readonly AdviceItem[] } | null;
}

/** One group per suite, in the order the panel lists the suites. */
export function suiteAdviceGroups(
  runs: Record<(typeof ADVICE_SUITES)[number], AdviceSource>,
): AdviceGroup[] {
  return ADVICE_SUITES.map((suite) => ({
    suite: SUITE_COPY[suite].title,
    readiness: runs[suite].result?.readiness,
  }));
}

/** The spec's requirement words are defined by BCP 14 (RFC 2119 + RFC 8174). */
const BCP_14_URL = "https://datatracker.ietf.org/doc/html/bcp14";

function SpecWord({ word }: { word: string }) {
  return (
    <a
      href={BCP_14_URL}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {word}
    </a>
  );
}

/** MAY is optional; SHOULD is what the spec asks for. */
function isOptional(item: AdviceItem): boolean {
  return item.specStrength === "MAY";
}

/** A field the spec deprecates without a SHOULD or MAY. */
function isDeprecation(item: AdviceItem): boolean {
  return item.specStrength === "Deprecation Notice";
}

export function ConformanceAdvice({ groups }: { groups: AdviceGroup[] }) {
  const [open, setOpen] = useState(false);
  // Suggested before Optional, each in suite order.
  const items = groups
    .flatMap((group) =>
      (group.readiness ?? []).map((item) => ({ ...item, suite: group.suite })),
    )
    .sort((a, b) => Number(isOptional(a)) - Number(isOptional(b)));
  if (items.length === 0) return null;

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
        <span className="rounded-full bg-info/10 px-1.5 py-px text-xs font-medium tabular-nums text-info">
          {items.length}
        </span>
      </button>
      {/* Outside the toggle: a link can't sit inside a button. */}
      <p className="px-4 pb-4 pl-11 text-sm text-muted-foreground">
        None of these fail a check. Suggested (<SpecWord word="SHOULD" />) means
        the spec asks for it. Optional (<SpecWord word="MAY" />) means it helps
        but the spec doesn't require it. A deprecation notice means the spec
        will remove something the server still uses.
      </p>
      <Collapse open={open}>
        <ul className="border-t border-border/60 px-4">
          {items.map((item) => (
            <li
              key={`${item.suite}-${item.id}`}
              className="flex items-start gap-2.5 border-b border-border/60 py-2.5 last:border-0"
            >
              <Info
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-info"
              />
              <span className="flex min-w-0 flex-col gap-0.5 text-sm">
                <span>
                  <span className="font-medium text-info">
                    {isDeprecation(item)
                      ? "Deprecation notice"
                      : `${isOptional(item) ? "Optional" : "Suggested"} (${item.specStrength})`}
                  </span>{" "}
                  <span className="text-muted-foreground">{item.suite}</span>{" "}
                  <span className="font-medium">{item.title}</span>
                </span>
                <span className="text-muted-foreground">{item.message}</span>
              </span>
            </li>
          ))}
        </ul>
      </Collapse>
    </section>
  );
}
