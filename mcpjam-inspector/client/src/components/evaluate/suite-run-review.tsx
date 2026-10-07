import { DEFAULTS } from "../evals/constants";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { convexErrMessage } from "@/lib/convex-error";
import { Loader2, Play, Settings2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { RunIterationControl } from "./run-iteration-control";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import { compactModelIdTail } from "@/lib/environment-label";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { ConfiguredSuiteRunReview } from "./suite-run-matrix";
import {
  hasBlockingPreflight,
  RunPreflightNotices,
  scopePreflightToEnvironments,
  scopePreflightToHosts,
  type RunPreflightState,
} from "./suite-run-preflight";
import type { EvalCase, EvalSuite } from "../evals/types";
import { reasoningEffortLabel } from "@/components/effort/effort-control";

type ReviewEnvironment = Pick<
  ProjectEnvironmentView,
  | "environmentId"
  | "hostId"
  | "modelId"
  | "modelSelection"
  | "name"
  | "serverAttachmentId"
  | "skillSelection"
  | "secretSelection"
  | "computerEnvironmentId"
>;
export type SuiteRunReviewProps = {
  projectId?: string | null;
  suite: EvalSuite;
  cases: readonly EvalCase[];
  environments?: readonly ReviewEnvironment[];
  hostNamesById: ReadonlyMap<string, string | null>;
  onClose: () => void;
  onStart: (
    suite: EvalSuite,
    options: {
      iterationOverride: number;
      ephemeralEnvironment?: boolean;
      throwOnFailure?: boolean;
    },
  ) => unknown;
  onEditSettings?: () => void;
  disabledReason?: string | null;
  preflight?: RunPreflightState;
};

export function suiteReviewTargets(
  suite: EvalSuite,
  environments: readonly ReviewEnvironment[],
  names: ReadonlyMap<string, string | null>,
) {
  if (suite.environmentIds?.length)
    return suite.environmentIds.map((id) => {
      const environment = environments.find(
        (item) => item.environmentId === id,
      );
      return {
        id,
        client: environment
          ? (names.get(environment.hostId) ??
            `Client …${environment.hostId.slice(-6)}`)
          : `Environment …${id.slice(-6)}`,
        model: environment?.modelId
          ? `${compactModelIdTail(environment.modelId)}${
              environment.modelSelection?.settings?.reasoningEffort
                ? ` · ${reasoningEffortLabel(environment.modelSelection.settings.reasoningEffort)}`
                : ""
            }`
          : "Client default",
        detail: environment?.name,
      };
    });
  if (suite.hostAttachments?.length)
    return suite.hostAttachments.map((host) => ({
      id: host.namedHostId,
      client:
        names.get(host.namedHostId) ??
        host.hostName ??
        `Client …${host.namedHostId.slice(-6)}`,
      model: "Case models",
      detail: undefined,
    }));
  return [
    {
      // Defensive fallback for older suites; the backend self-heals on launch.
      id: "suite-default",
      client: "Suite configuration",
      model: "Case models",
      detail: undefined,
    },
  ];
}

export function selectReviewTargets(
  suite: EvalSuite,
  selected: readonly string[],
): EvalSuite {
  if (selected.length === 0)
    throw new Error("Select at least one client and model.");
  const filtered = suite.environmentIds?.length
    ? {
        ...suite,
        environmentIds: suite.environmentIds.filter((id) =>
          selected.includes(id),
        ),
      }
    : suite.hostAttachments?.length
      ? {
          ...suite,
          hostAttachments: suite.hostAttachments.filter((host) =>
            selected.includes(host.namedHostId),
          ),
        }
      : suite;
  if (
    (suite.environmentIds?.length && !filtered.environmentIds?.length) ||
    (suite.hostAttachments?.length &&
      !suite.environmentIds?.length &&
      !filtered.hostAttachments?.length)
  )
    throw new Error(
      "The selected targets are no longer attached to this suite.",
    );
  return filtered;
}

const REMEMBERED_ITERATIONS_PREFIX = "mcpjam:suite-run-iterations";

function readRememberedIterations(suiteId: string): number | null {
  try {
    const value = Number(
      localStorage.getItem(`${REMEMBERED_ITERATIONS_PREFIX}:${suiteId}`),
    );
    return Number.isInteger(value) && value >= 1 && value <= 10 ? value : null;
  } catch {
    return null;
  }
}

function rememberIterations(suiteId: string, count: number) {
  try {
    localStorage.setItem(
      `${REMEMBERED_ITERATIONS_PREFIX}:${suiteId}`,
      String(count),
    );
  } catch {
    // Storage can be blocked; the sheet then falls back to the suite default.
  }
}

export function SuiteRunReview(props: SuiteRunReviewProps) {
  const projectId = props.projectId ?? props.suite.projectId;
  return projectId ? (
    <ConfiguredSuiteRunReview {...props} projectId={projectId} />
  ) : (
    <SuiteRunReviewContent {...props} />
  );
}

export function SuiteRunReviewContent({
  suite,
  cases,
  environments = [],
  hostNamesById,
  onClose,
  onStart,
  onEditSettings,
  disabledReason: blockedReason,
  preflight,
  matrix,
}: SuiteRunReviewProps & {
  matrix?: {
    count: number;
    render: (disabled: boolean) => ReactNode;
    /** Changes whenever the matrix selection does. */
    signature?: string;
  };
}) {
  const targets = suiteReviewTargets(suite, environments, hostNamesById);
  const [selected, setSelected] = useState(() =>
    targets.map((target) => target.id),
  );
  // Last started count, else configured repetitions; never below the suite minimum.
  const [iterations, setIterations] = useState(() =>
    String(
      Math.min(
        10,
        Math.max(
          readRememberedIterations(suite._id) ??
            suite.verdictPolicyDefaults?.repetitions ??
            DEFAULTS.RUNS_PER_TEST,
          suite.minIterations ?? 1,
        ),
      ),
    ),
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // A failed start's reason is about that setup; a different one gets a
  // fresh try.
  useEffect(() => setError(null), [iterations, selected, matrix?.signature]);
  const lock = useRef(false);
  const count = Number(iterations);
  const validCount = Number.isInteger(count) && count >= 1 && count <= 10;
  const activeTargets = targets.filter((target) =>
    selected.includes(target.id),
  );
  const selectionCount = matrix?.count ?? activeTargets.length;
  // Without the matrix, the clients or environments are picked here, so only
  // theirs count.
  const selectedIds = activeTargets.map((target) => target.id);
  const scopedPreflight =
    !preflight || matrix
      ? preflight
      : suite.environmentIds?.length
        ? scopePreflightToEnvironments(preflight, selectedIds)
        : suite.hostAttachments?.length
          ? scopePreflightToHosts(preflight, suite, selectedIds)
          : preflight;
  // The notices say which server; this only has to stop the launch.
  const disabledReason =
    blockedReason ??
    (hasBlockingPreflight(scopedPreflight)
      ? "Fix the setup problem above before running."
      : null);
  const variantsPerTarget =
    matrix || suite.environmentIds?.length
      ? cases.length
      : cases.reduce((sum, item) => sum + Math.max(1, item.models.length), 0);
  const total = validCount ? variantsPerTarget * count * selectionCount : null;
  const start = async () => {
    if (
      lock.current ||
      connecting ||
      !validCount ||
      !selectionCount ||
      disabledReason ||
      !cases.length
    )
      return;
    lock.current = true;
    setStarting(true);
    setError(null);
    try {
      await onStart(
        matrix
          ? suite
          : selectReviewTargets(
              suite,
              activeTargets.map((target) => target.id),
            ),
        // Failures come back here to show inline, not as a toast behind it.
        { iterationOverride: count, throwOnFailure: true },
      );
      rememberIterations(suite._id, count);
      onClose();
    } catch (failure) {
      // A ConvexError keeps its reason in `data`; its message is the raw
      // "[CONVEX M(…)] Server Error".
      setError(
        convexErrMessage(failure, "Could not start this run. Try again."),
      );
    } finally {
      lock.current = false;
      setStarting(false);
    }
  };
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !starting) onClose();
      }}
    >
      <SheetContent
        className="w-full gap-0 sm:max-w-xl"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (starting) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (starting) event.preventDefault();
        }}
      >
        <SheetHeader className="border-b border-border px-6 py-4 pr-12">
          <SheetTitle className="break-words text-lg tracking-tight">
            Setup Run · {suite.name}
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          <RunIterationControl
            value={iterations}
            onChange={setIterations}
            disabled={starting}
          />
          {matrix ? (
            matrix.render(starting)
          ) : (
            <section>
              <h3 className="text-sm font-semibold">
                Clients × models{" "}
                <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
                  {activeTargets.length}/{targets.length}
                </span>
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Each client/model combination runs the whole suite.
              </p>
              <div className="mt-3 overflow-hidden rounded-lg border border-border">
                {targets.map((target) => (
                  <label
                    key={target.id}
                    className="flex cursor-pointer items-center gap-3 border-b border-border/60 p-4 last:border-0 hover:bg-muted/30"
                  >
                    <Checkbox
                      checked={selected.includes(target.id)}
                      disabled={starting}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked
                            ? [...current, target.id]
                            : current.filter((id) => id !== target.id),
                        )
                      }
                      aria-label={`${target.client} · ${target.model}${
                        target.detail ? ` · ${target.detail}` : ""
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        {target.client}
                      </span>
                      {target.detail && (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {target.detail}
                        </span>
                      )}
                    </span>
                    <span className="max-w-[50%] break-words text-right font-mono text-xs text-muted-foreground">
                      {target.model}
                    </span>
                  </label>
                ))}
              </div>
              {!selectionCount && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  Select at least one client and model.
                </p>
              )}
            </section>
          )}
          {scopedPreflight && (
            <RunPreflightNotices
              preflight={scopedPreflight}
              disabled={starting}
              onConnectingChange={setConnecting}
              onEditSettings={
                onEditSettings
                  ? () => {
                      onClose();
                      onEditSettings();
                    }
                  : undefined
              }
            />
          )}
          {onEditSettings && (
            <Button
              variant="secondary"
              size="sm"
              disabled={starting}
              onClick={() => {
                onClose();
                onEditSettings();
              }}
            >
              <Settings2 className="size-4" aria-hidden />
              Configure suite evaluators
            </Button>
          )}
        </div>
        <div className="space-y-4 border-t border-border bg-muted/20 p-6">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <p className="text-sm text-muted-foreground">
                <strong className="font-semibold tabular-nums text-foreground">
                  {cases.length}
                </strong>{" "}
                cases ×{" "}
                <strong className="font-semibold tabular-nums text-foreground">
                  {validCount ? count : "—"}
                </strong>{" "}
                repetitions ×{" "}
                <strong className="font-semibold tabular-nums text-foreground">
                  {selectionCount}
                </strong>{" "}
                client:model combos
              </p>
              {variantsPerTarget !== cases.length && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Includes {variantsPerTarget} case/model combinations per
                  client.
                </p>
              )}
            </div>
            <p className="shrink-0 font-mono text-xl font-semibold">
              {total?.toLocaleString() ?? "—"}
              <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">
                iterations
              </span>
            </p>
          </div>
          {(error || (!starting && disabledReason)) && (
            <p role="alert" className="text-xs text-destructive">
              {error ?? disabledReason}
            </p>
          )}
          <Button
            className="w-full"
            disabled={
              starting ||
              connecting ||
              !validCount ||
              !selectionCount ||
              !cases.length ||
              Boolean(disabledReason)
            }
            onClick={() => void start()}
          >
            {starting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            {starting ? "Starting run…" : "Start run"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
