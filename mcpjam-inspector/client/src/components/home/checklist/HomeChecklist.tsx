import { useCallback, useEffect, useRef, useState } from "react";
import { useIsPresent } from "framer-motion";
import { CircleCheck } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Progress } from "@mcpjam/design-system/progress";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { ErrorCard } from "@/components/ui/error-card";
import { track } from "@/lib/analytics";
import {
  buildConformanceRunPath,
  buildConformanceSetupPath,
  buildEvaluatePath,
  buildEvaluateSuiteRunPath,
  routePaths,
  useAppNavigate,
} from "@/lib/app-navigation";
import { useAppRouteContext } from "@/lib/app-route-context";
import { useSoftQuery } from "@/hooks/use-soft-query";
import { PLAYGROUND_FIRST_RUN_PROMPT } from "@/components/ui-playground/hooks/use-playground-state";
import type { ConformanceRunListItem } from "@/components/conformance/ConformanceHistory";
import type { EvalSuiteOverviewEntry } from "@/components/evals/types";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import type { EnsureServersReadyResult } from "@/hooks/use-server-state";
import type { ServerWithName } from "@/state/app-types";
import { AgentStep } from "./AgentStep";
import { ChecklistStepRow } from "./ChecklistStepRow";
import { ConnectStep } from "./ConnectStep";
import { useProgressFromLastVisit } from "./checklist-motion";
import {
  checklistProgressKey,
  useChecklistProgress,
} from "./checklist-progress";
import { writeHomeChecklistAutorun } from "./playground-autorun";
import { computeChecklistSignals, type StepId } from "./checklist-signals";

const STEP_ORDER: StepId[] = [
  "connect",
  "chat",
  "onboard_agent",
  "check_server",
  "create_eval",
];
/** "Skip the rest" appears once this many steps are done. */
const SKIP_REST_AFTER = 3;
const FINISH_HOLD_MS = 1500;

type GuardFailure = { step: StepId; message: string; reauth: boolean };

function trackStep(step: StepId, action: string, extra: object = {}) {
  track("home_checklist_step", {
    location: "home",
    step,
    action,
    variant: "treatment",
    ...extra,
  });
}

/**
 * The treatment Home; renders nothing once done or skipped (`onFinished`).
 * `shown` says whether it was on screen, so Home can animate the handoff.
 */
export function HomeChecklist({
  onFinished,
}: {
  onFinished: (shown: boolean) => void;
}) {
  const navigate = useAppNavigate();
  const ctx = useAppRouteContext();
  const projectServers = (ctx.projectServers ?? {}) as Record<
    string,
    ServerWithName
  >;
  // Unconnected saved servers are only in `projectServers`; runtime has live status.
  const runtimeServers = (ctx.appState?.servers ?? {}) as Record<
    string,
    ServerWithName
  >;
  const convexProjectId: string | null = ctx.convexProjectId ?? null;
  const userId: string | null = ctx.currentUser?._id ?? null;
  const progressKey =
    userId && convexProjectId
      ? checklistProgressKey(userId, convexProjectId)
      : null;
  const { progress, update } = useChecklistProgress(progressKey);

  const [provisional, setProvisional] = useState<string[]>([]);
  const confirmedServers = Object.keys(projectServers).filter(
    (name) => !provisional.includes(name),
  );
  const selected: string | undefined = ctx.appState?.selectedServer;
  const serverName =
    selected && confirmedServers.includes(selected)
      ? selected
      : (confirmedServers[0] ?? null);

  const conformanceQuery = useSoftQuery<ConformanceRunListItem[]>(
    "conformanceRuns:latestRunPerServer",
    convexProjectId ? { projectId: convexProjectId } : "skip",
  );
  const suitesQuery = useSoftQuery<EvalSuiteOverviewEntry[]>(
    "testSuites:getTestSuitesOverview",
    convexProjectId ? { projectId: convexProjectId } : "skip",
  );
  const historyQuery = useSoftQuery<{ personal?: ChatHistorySession[] }>(
    "directChatHistory:listCurrentHistory",
    convexProjectId ? { projectId: convexProjectId, status: "active" } : "skip",
  );
  const conformanceRuns = conformanceQuery.data;
  const suites = suitesQuery.data;
  const answered = (query: { data?: unknown; error?: unknown }) =>
    query.data !== undefined || query.error !== undefined;
  // Until all answer, steps 2, 4 and 5 would read as not done.
  const loaded =
    !convexProjectId ||
    (answered(conformanceQuery) &&
      answered(suitesQuery) &&
      answered(historyQuery));
  const signals = computeChecklistSignals({
    hasServer: confirmedServers.length > 0,
    hasPlaygroundChat: (historyQuery.data?.personal ?? []).some(
      (session) => session.messageCount > 0,
    ),
    progress,
    userId,
    conformanceRuns: conformanceRuns ?? [],
    suites: suites ?? [],
  });
  const doneCount = STEP_ORDER.filter((step) => signals.done[step]).length;
  const allDone = doneCount === STEP_ORDER.length;
  const handedBack = Boolean(progress.finished || progress.skippedAll);
  const doneOnArrival = useRef<boolean | null>(null);
  // Done before ever seeing the checklist (nothing reported yet), not a last
  // step finished elsewhere, which still gets the "5 of 5" hold.
  if (loaded && doneOnArrival.current === null)
    doneOnArrival.current = allDone && !progress.reported;
  const hidden = handedBack || (loaded && Boolean(doneOnArrival.current));
  // Keeps the last frame on screen while Home collapses it after handing back.
  const present = useIsPresent();
  const wasShown = useRef(false);
  if (loaded && !hidden) wasShown.current = true;
  const saveShown = useCallback((shown: number) => update({ shown }), [update]);
  const barCount = useProgressFromLastVisit(
    doneCount,
    loaded && !hidden,
    progress.shown,
    saveShown,
  );
  // The last step holds on "5 of 5"; skipping or arriving done goes straight back.
  useEffect(() => {
    if (!loaded || handedBack) return;
    const reported = progress.reported ?? [];
    const fresh = STEP_ORDER.filter(
      (s) => s !== "onboard_agent" && signals.done[s] && !reported.includes(s),
    );
    if (fresh.length === 0 && progress.reported) return;
    for (const step of fresh) {
      trackStep(step, "completed", { already_done: !progress.reported });
    }
    update({ reported: [...reported, ...fresh] });
  }, [loaded, handedBack, progress.reported, signals.done, update]);
  useEffect(() => {
    if (handedBack) {
      onFinished(wasShown.current);
      return;
    }
    if (!loaded || !allDone) return;
    const finish = () => {
      track("home_checklist_finished", {
        location: "home",
        outcome: "completed",
        done_count: STEP_ORDER.length,
        already_done: Boolean(doneOnArrival.current),
      });
      update({ finished: true });
      onFinished(wasShown.current);
    };
    if (doneOnArrival.current) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, FINISH_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [handedBack, loaded, allDone, update, onFinished]);

  const firstOpen = loaded
    ? (STEP_ORDER.find((step) => !signals.done[step]) ?? null)
    : null;
  const [openStep, setOpenStep] = useState<StepId | null>(null);
  const shownStep: StepId =
    openStep ?? firstOpen ?? STEP_ORDER[STEP_ORDER.length - 1];
  const viewedRef = useRef<StepId | null>(null);
  useEffect(() => {
    if (!firstOpen || viewedRef.current === firstOpen) return;
    viewedRef.current = firstOpen;
    trackStep(firstOpen, "viewed");
  }, [firstOpen]);

  const [checking, setChecking] = useState<StepId | null>(null);
  const [guardFailure, setGuardFailure] = useState<GuardFailure | null>(null);
  // Read right before the CTA runs, not the possibly stale render-time status.
  const withServer = useCallback(
    async (step: StepId, go: (name: string) => void) => {
      if (!serverName) return;
      setChecking(step);
      setGuardFailure(null);
      let result: EnsureServersReadyResult | null = null;
      try {
        result = await ctx.ensureServersReady([serverName]);
      } finally {
        setChecking(null);
      }
      if (result?.readyServerNames.includes(serverName)) {
        go(serverName);
        return;
      }
      const reauth = Boolean(result?.reauthServerNames.includes(serverName));
      setGuardFailure({
        step,
        reauth,
        message: reauth
          ? `${serverName}'s sign-in expired. Sign in again to continue.`
          : (result?.failedServerErrors?.[serverName] ??
            `${serverName} is disconnected. Reconnect it to continue.`),
      });
    },
    [ctx, serverName],
  );
  const reconnect = async (step: StepId, go: (name: string) => void) => {
    if (!serverName) return;
    await ctx.reconnectServerWithResult(serverName, {
      allowInteractiveOAuthFlow: true,
    });
    await withServer(step, go);
  };

  const openPlayground = (name: string) => {
    ctx.setSelectedServer(name);
    ctx.setSelectedMCPConfigs([name]);
    if (progressKey) {
      writeHomeChecklistAutorun({
        prompt: PLAYGROUND_FIRST_RUN_PROMPT,
        progressKey,
      });
    }
    trackStep("chat", "opened");
    navigate(routePaths.playground);
  };
  const openConformance = (name: string) => {
    ctx.setSelectedServer(name);
    trackStep("check_server", "opened");
    navigate(buildConformanceSetupPath());
  };
  const openEvals = () => {
    const suiteId = signals.eval.suiteId;
    trackStep("create_eval", "opened");
    if (!suiteId) navigate(buildEvaluatePath({ type: "create" }));
    else if (signals.done.create_eval)
      navigate(buildEvaluatePath({ type: "suite-overview", suiteId }));
    else navigate(buildEvaluateSuiteRunPath(suiteId));
  };

  const serverLabel = serverName ?? "your server";
  const cta = (
    step: StepId,
    label: string,
    go: (name: string) => void,
    variant: "default" | "outline" = "default",
  ) => (
    <>
      {guardFailure?.step === step ? (
        <ErrorCard
          density="row"
          error={guardFailure.message}
          action={{
            label: guardFailure.reauth ? "Sign in" : "Reconnect",
            onClick: () => void reconnect(step, go),
          }}
        />
      ) : null}
      <Button
        type="button"
        size="sm"
        variant={variant}
        disabled={!serverName || checking !== null}
        onClick={() => void withServer(step, go)}
      >
        {checking === step ? "Checking your server…" : label}
      </Button>
    </>
  );

  const steps = {
    connect: {
      title: "Connect your server",
      surface: "Connect",
      summary: serverName ? `Connected: ${serverName}` : null,
    },
    chat: {
      title: `Try ${serverLabel} in Playground`,
      surface: "Playground",
      summary: signals.done.chat ? "First Playground run complete" : null,
    },
    onboard_agent: {
      title: "Add MCPJam to your coding agent",
      surface: "Claude Code, Cursor, ChatGPT and more",
      summary: progress.agent
        ? "Added to your agent"
        : progress.skippedAgent
          ? "Skipped"
          : null,
    },
    check_server: {
      title: "Check your server",
      surface: "Conformance",
      summary: signals.conformance.run
        ? `${signals.conformance.run.passed} of ${signals.conformance.run.applicable} checks passed`
        : null,
    },
    create_eval: {
      title: "Run your first eval",
      surface: "Evaluate",
      summary:
        signals.eval.passRate !== null
          ? `Latest run: ${Math.round(signals.eval.passRate * 100)}% passed`
          : null,
    },
  } satisfies Record<
    StepId,
    { title: string; surface: string; summary: string | null }
  >;

  const body = (step: StepId) => {
    switch (step) {
      case "connect":
        return (
          <ConnectStep
            servers={{ ...projectServers, ...runtimeServers }}
            onConnect={ctx.handleConnect}
            onRemove={ctx.handleRemoveServer}
            onReconnect={(name) =>
              ctx.reconnectServerWithResult(name, {
                allowInteractiveOAuthFlow: true,
              })
            }
            onAttemptChange={setProvisional}
            onConfirmed={(name) => {
              ctx.setSelectedServer(name);
              setOpenStep(null);
            }}
            onTrack={(action, extra) => trackStep("connect", action, extra)}
          />
        );
      case "chat":
        return (
          <>
            <p className="text-sm text-muted-foreground">
              Playground opens and asks {serverLabel} what it can do.
            </p>
            {cta("chat", "Open Playground", openPlayground)}
          </>
        );
      case "onboard_agent":
        return (
          <AgentStep
            done={signals.done.onboard_agent}
            onCopied={(agent) =>
              trackStep("onboard_agent", "copied", { agent })
            }
            onConfirm={() => {
              update({ agent: true });
              trackStep("onboard_agent", "completed");
              setOpenStep(null);
            }}
            onSkip={() => {
              update({ skippedAgent: true });
              trackStep("onboard_agent", "skipped");
              setOpenStep(null);
            }}
          />
        );
      case "check_server": {
        const run = signals.conformance.run;
        return (
          <>
            <p className="text-sm text-muted-foreground">
              Run conformance checks to see how {serverLabel} follows the MCP
              spec.
            </p>
            <div className="flex flex-wrap gap-2">
              {run ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    navigate(
                      buildConformanceRunPath(run._id, ctx.activeProjectId),
                    )
                  }
                >
                  Open run
                </Button>
              ) : (
                cta("check_server", "Open Conformance", openConformance)
              )}
            </div>
          </>
        );
      }
      case "create_eval":
        return (
          <>
            <p className="text-sm text-muted-foreground">
              See how reliably a model picks the right {serverLabel} tool for
              each request. Each run gives you a pass rate.
            </p>
            {cta(
              "create_eval",
              signals.done.create_eval
                ? "Open eval"
                : signals.eval.suiteId
                  ? "Run eval"
                  : "Open evals",
              openEvals,
            )}
          </>
        );
    }
  };

  if (hidden && (present || !wasShown.current)) return null;
  if (!loaded) return <Skeleton className="h-[30rem] w-full rounded-xl" />;

  const shownIndex = STEP_ORDER.indexOf(shownStep);

  return (
    <section aria-labelledby="home-checklist-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {allDone ? (
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <CircleCheck className="size-4 text-success" aria-hidden />
            You&apos;re all set.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Five steps from a server URL to your first eval.
          </p>
        )}
        <div className="flex items-center gap-2.5">
          <span
            className="text-xs font-medium text-muted-foreground"
            aria-live="polite"
          >
            {barCount} of {STEP_ORDER.length} set up
          </span>
          <Progress
            value={(barCount / STEP_ORDER.length) * 100}
            aria-label="Setup progress"
            tone="success"
            pace="gradual"
            className="h-1.5 w-32 bg-muted"
          />
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2
            id="home-checklist-title"
            className="text-sm font-semibold text-card-foreground"
          >
            Finish setting up your project
          </h2>
          {doneCount >= SKIP_REST_AFTER ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                update({ skippedAll: true });
                trackStep(firstOpen ?? "create_eval", "skipped", {
                  rest: true,
                });
                track("home_checklist_finished", {
                  location: "home",
                  outcome: "skipped",
                  done_count: doneCount,
                  already_done: false,
                });
              }}
            >
              Skip the rest
            </Button>
          ) : null}
        </div>
        <div className="grid min-h-[28rem] md:grid-cols-2">
          <ol className="space-y-1 border-b border-border p-2 md:border-r md:border-b-0">
            {STEP_ORDER.map((step, i) => (
              <ChecklistStepRow
                key={step}
                index={i + 1}
                title={steps[step].title}
                surface={steps[step].surface}
                summary={steps[step].summary}
                done={signals.done[step]}
                selected={shownStep === step}
                onSelect={() => setOpenStep(step)}
              />
            ))}
          </ol>
          <div className="space-y-4 bg-card p-8 dark:bg-muted">
            <p className="text-xs text-muted-foreground">
              Step {shownIndex + 1} of {STEP_ORDER.length}
            </p>
            <h3 className="text-xl font-semibold text-foreground">
              {steps[shownStep].title}
            </h3>
            {body(shownStep)}
          </div>
        </div>
      </div>
    </section>
  );
}
