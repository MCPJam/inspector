/**
 * The execution preview: a case's steps, assertions, expected outcome and
 * end-of-run grading in the order a run meets them. The test run docks it
 * beside its body; the editor docks it beside the case. Same list either way;
 * the test run's variant says where a click goes before going there.
 */
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { UNSAFE_LocationContext } from "react-router";
import { ArrowRight, ChevronDown, Diamond, Flag, Info, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { parseProjectPath } from "@/lib/project-route";
import { trackEvalNav } from "../nav/eval-nav-analytics";
import type { PreviewItem, PreviewMarker } from "./case-steps-model";

export const EXECUTION_PREVIEW_OPEN_KEY = "mcpjam:eval-execution-preview-open";

/** How long the test run shows where a click is going before it goes. */
export const PREVIEW_LEAVE_DELAY_MS = 500;

function readStoredOpen(): boolean {
  try {
    return window.localStorage.getItem(EXECUTION_PREVIEW_OPEN_KEY) === "1";
  } catch {
    // Storage blocked: start closed, as a first visit does.
    return false;
  }
}

/** True when the choice was remembered; false when storage refused it. */
function writeStoredOpen(open: boolean): boolean {
  try {
    window.localStorage.setItem(EXECUTION_PREVIEW_OPEN_KEY, open ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}

/**
 * Open state remembered in this browser across pages and reloads; starts
 * closed. With a `surface`, opening it fires eval_execution_preview_opened
 * for that surface; a panel restored open from storage is not counted.
 */
export function useExecutionPreviewOpen(
  surface?: "editor" | "test_run",
): [open: boolean, setOpen: (open: boolean) => void] {
  const [open, setOpenState] = useState(readStoredOpen);
  const openRef = useRef(open);
  const locationContext = useContext(UNSAFE_LocationContext);
  const pathname =
    locationContext?.location.pathname ??
    (typeof window === "undefined" ? "" : window.location.pathname);
  const projectId = parseProjectPath(pathname)?.projectId ?? null;
  const setOpen = useCallback(
    (next: boolean) => {
      if (surface && next && !openRef.current) {
        trackEvalNav("eval_execution_preview_opened", {
          surface,
          project_id: projectId,
        });
      }
      openRef.current = next;
      setOpenState(next);
      writeStoredOpen(next);
    },
    [surface, projectId],
  );
  return [open, setOpen];
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** A diamond on a spine, the shape of the preview's own list; filled while open. */
export function ExecutionPreviewToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant={open ? "secondary" : "outline"}
      size="sm"
      className="h-7 w-7 shrink-0 p-0"
      aria-pressed={open}
      aria-label="Execution preview"
      title={open ? "Hide execution preview" : "Show execution preview"}
      onClick={onToggle}
    >
      <svg
        viewBox="0 0 16 16"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M8 1v3.5M8 11.5V15" />
        <path
          d="M8 4.5 11.5 8 8 11.5 4.5 8Z"
          fill={open ? "currentColor" : "none"}
        />
      </svg>
    </Button>
  );
}

function Marker({
  marker,
  size,
}: {
  marker: PreviewMarker;
  size: "row" | "key";
}) {
  const dot = size === "row" ? "mt-1.5 size-2.5" : "size-2";
  const icon = size === "row" ? "mt-1 size-3.5" : "size-3";
  switch (marker) {
    case "agent":
      return (
        <span
          aria-hidden="true"
          className={cn(dot, "shrink-0 rounded-full bg-primary")}
        />
      );
    case "runner":
      return (
        <span
          aria-hidden="true"
          className={cn(
            dot,
            "shrink-0 rounded-full border-2 border-muted-foreground/50",
          )}
        />
      );
    case "check":
      return (
        <Diamond
          aria-hidden="true"
          className={cn(icon, "shrink-0 text-success")}
        />
      );
    case "outcome":
      return (
        <Flag
          aria-hidden="true"
          className={cn(icon, "shrink-0 text-foreground")}
        />
      );
  }
}

function ProvenanceChip({ suite }: { suite: boolean }) {
  return (
    <span
      title={
        suite
          ? "Shared default, set in suite settings"
          : "Set on this case only"
      }
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[11px] font-medium",
        suite ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
      )}
    >
      {suite ? "Suite" : "This case"}
    </span>
  );
}

type KeyEntry = {
  mark: PreviewMarker | "suite" | "case";
  short: string;
  long: string;
};
const KEY_ENTRIES: KeyEntry[] = [
  {
    mark: "agent",
    short: "Agent runs",
    long: "The agent runs (a model is called)",
  },
  {
    mark: "runner",
    short: "No model",
    long: "MCPJam acts directly (no model)",
  },
  { mark: "check", short: "Assertion", long: "An assertion is graded" },
  {
    mark: "suite",
    short: "Suite default",
    long: "Shared default from suite settings",
  },
  { mark: "case", short: "This case only", long: "Set on this case only" },
];

/** The test run's key is small, with short words; the editor's says it in full. */
function PreviewKey({ variant }: { variant: "test_run" | "editor" }) {
  const inRun = variant === "test_run";
  return (
    <div
      aria-label="Key"
      className={cn(
        "border-t border-border/60 text-muted-foreground",
        inRun
          ? "mt-4 flex flex-wrap gap-x-3 gap-y-1.5 pt-3 text-[11px]"
          : "mt-5 space-y-2 pt-4 text-xs",
      )}
    >
      {KEY_ENTRIES.map(({ mark, short, long }) => (
        <span
          key={mark}
          className={cn("flex items-center", inRun ? "gap-1.5" : "gap-2")}
        >
          {mark === "suite" || mark === "case" ? (
            <ProvenanceChip suite={mark === "suite"} />
          ) : (
            <Marker marker={mark} size={inRun ? "key" : "row"} />
          )}
          <span>{inRun ? short : long}</span>
        </span>
      ))}
    </div>
  );
}

export function ExecutionPreviewPanel({
  items,
  variant,
  onJump,
  onClose,
  flashKey = null,
}: {
  items: PreviewItem[];
  /** test_run: small key, and a click says where it is going before it goes. */
  variant: "test_run" | "editor";
  onJump: (key: string) => void;
  onClose: () => void;
  /** editor only: the row just arrived at, pulsed. */
  flashKey?: string | null;
}) {
  const inRun = variant === "test_run";
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [leaving, setLeaving] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const go = (key: string) => {
    if (!inRun || prefersReducedMotion()) {
      onJump(key);
      return;
    }
    setLeaving(key);
    timer.current = setTimeout(() => onJump(key), PREVIEW_LEAVE_DELAY_MS);
  };
  const toggleRow = (key: string) =>
    setOpenRows((rows) => {
      const next = new Set(rows);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <aside
      data-slot="execution-preview"
      aria-label="Execution preview"
      className="sticky top-0 flex min-h-0 shrink-0 flex-col self-start overflow-hidden rounded-xl border border-border/60 bg-background"
      style={{ width: "min(100%, 340px)", maxHeight: "calc(100vh - 9rem)" }}
    >
      <div className="flex items-start justify-between gap-2 border-b border-border/40 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            Execution preview
          </p>
          <p className="text-xs text-muted-foreground">
            {inRun
              ? "How this case runs, in order. Click a step to open it in the test case."
              : "How this case will run, in order. Click a step to edit it."}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Close execution preview"
          className="h-8 w-8 shrink-0 rounded-full p-0 text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <ol className="relative">
          {items.map((item, index) => {
            const hasDetails = Boolean(item.detail || item.lines?.length);
            const open = openRows.has(item.key);
            return (
              <li
                key={item.key}
                className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0"
              >
                {index < items.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 left-3.5 top-7 w-px -translate-x-1/2 bg-border"
                  />
                )}
                <span className="relative z-10 flex size-7 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold text-foreground">
                  {index + 1}
                </span>
                <div className="flex min-w-0 items-start gap-1">
                  <button
                    type="button"
                    onClick={() => go(item.key)}
                    disabled={leaving !== null}
                    className={cn(
                      "flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      leaving === item.key &&
                        "bg-primary/10 hover:bg-primary/10",
                      flashKey === item.key && "bg-primary/10",
                    )}
                  >
                    <Marker marker={item.marker} size="row" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-1.5">
                        <span className="text-[13px] font-semibold leading-5 text-foreground">
                          {item.title}
                        </span>
                        {item.badge && (
                          <span className="text-xs text-muted-foreground">
                            · {item.badge}
                          </span>
                        )}
                      </span>
                      {open && item.detail && (
                        <span className="mt-0.5 block break-words text-xs text-muted-foreground">
                          {item.detail}
                        </span>
                      )}
                      {open && item.lines && (
                        <span className="mt-1 flex flex-col gap-1">
                          {item.lines.map((line, i) => (
                            <span
                              key={i}
                              className="flex items-start gap-1.5 text-xs text-muted-foreground"
                            >
                              <ProvenanceChip suite={line.suite} />
                              <span className="min-w-0 flex-1 pt-1">
                                {line.text}
                              </span>
                            </span>
                          ))}
                        </span>
                      )}
                      {leaving === item.key && (
                        <span
                          role="status"
                          className="mt-1 flex items-center gap-1 text-[11px] font-medium text-primary motion-safe:animate-in motion-safe:fade-in motion-safe:duration-[180ms]"
                        >
                          Opening in test case
                          <ArrowRight
                            aria-hidden="true"
                            className="size-3 motion-safe:animate-in motion-safe:slide-in-from-left-1 motion-safe:duration-[400ms]"
                          />
                        </span>
                      )}
                    </span>
                  </button>
                  {hasDetails && (
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={`${open ? "Hide" : "Show"} description: ${item.title}`}
                      onClick={() => toggleRow(item.key)}
                      className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronDown
                        aria-hidden="true"
                        className={cn(
                          "size-3.5 motion-safe:transition-transform",
                          open && "rotate-180",
                        )}
                      />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        <PreviewKey variant={variant} />
        <p
          className={cn(
            "flex items-start gap-2 text-muted-foreground",
            inRun ? "mt-3 text-[11px]" : "mt-4 text-xs",
          )}
        >
          <Info
            aria-hidden="true"
            className={cn("mt-px shrink-0", inRun ? "size-3" : "size-3.5")}
          />
          Suite settings configure grading; they are not a step in the run.
        </p>
      </div>
    </aside>
  );
}
