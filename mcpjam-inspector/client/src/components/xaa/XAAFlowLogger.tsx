import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Lightbulb,
  Loader2,
  Pencil,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Alert, AlertDescription } from "@mcpjam/design-system/alert";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { cn } from "@/lib/utils";
import { HTTPHistoryEntry } from "@/components/oauth/HTTPHistoryEntry";
import { InfoLogEntry } from "@/components/oauth/InfoLogEntry";
import { IdJagInspector } from "./IdJagInspector";
import {
  getXAAPhaseNumber,
  getXAAStepInfo,
  getXAAStepIndex,
  XAA_PHASE_ORDER,
  XAA_PHASES,
  XAA_STEP_ORDER,
  type XAAPhaseKey,
} from "@/lib/xaa/step-metadata";
import type { XAAFlowState, XAAFlowStep } from "@/lib/xaa/types";
import {
  getXAAErrorGuidance,
  latestErroredHttpEntry,
  type XAAErrorAction,
  type XAAErrorGuidance,
} from "@/lib/xaa/error-guidance";
import type {
  XAACheckStatus,
  XAACompatibilityReport,
} from "@/lib/xaa/capability-preflight";
import {
  NEGATIVE_TEST_MODES,
  NEGATIVE_TEST_MODE_DETAILS,
  type NegativeTestMode,
} from "@/shared/xaa.js";

interface XAAFlowLoggerProps {
  flowState: XAAFlowState;
  hasProfile: boolean;
  activeStep?: XAAFlowStep | null;
  onFocusStep?: (step: XAAFlowStep) => void;
  actions: {
    onConfigure: () => void;
    onReset?: () => void;
    onContinue?: () => void;
    /** Run the whole flow — surfaced in the Continue split-button's menu. */
    onRunAll?: () => void;
    onChangeNegativeTestMode?: (mode: NegativeTestMode) => void;
    continueLabel: string;
    continueDisabled?: boolean;
    runAllDisabled?: boolean;
    /** A Run all is in flight; the primary button shows a spinner. */
    isRunningAll?: boolean;
    resetDisabled?: boolean;
  };
  summary: {
    serverUrl?: string;
    authzServerIssuer?: string;
    clientId?: string;
    scope?: string;
    negativeTestMode: XAAFlowState["negativeTestMode"];
  };
}

function CompatibilityBanner({ report }: { report: XAACompatibilityReport }) {
  const [expanded, setExpanded] = useState(report.overall !== "pass");
  useEffect(() => {
    setExpanded(report.overall !== "pass");
  }, [report.overall]);

  const tone =
    report.overall === "pass"
      ? {
          Icon: ShieldCheck,
          iconClass: "text-green-600 dark:text-green-400",
          borderClass: "border-green-500/40",
          bgClass: "bg-green-500/5",
          title: "Authorization server looks XAA-ready",
        }
      : report.overall === "warn"
      ? {
          Icon: AlertTriangle,
          iconClass: "text-amber-500",
          borderClass: "border-amber-500/40",
          bgClass: "bg-amber-500/5",
          title: "Authorization server capabilities are ambiguous",
        }
      : {
          Icon: ShieldAlert,
          iconClass: "text-red-500",
          borderClass: "border-red-500/40",
          bgClass: "bg-red-500/5",
          title: "Authorization server isn't XAA-ready",
        };

  const checkStatusClass = (status: XAACheckStatus) =>
    status === "pass"
      ? "text-green-600 dark:text-green-400"
      : status === "fail"
      ? "text-red-500"
      : "text-amber-500";

  const checkStatusSymbol = (status: XAACheckStatus) =>
    status === "pass" ? "✓" : status === "fail" ? "✗" : "?";

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2.5 text-xs",
        tone.borderClass,
        tone.bgClass
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-start gap-2 text-left"
      >
        <tone.Icon className={cn("h-4 w-4 mt-0.5 shrink-0", tone.iconClass)} />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="font-medium text-foreground">{tone.title}</div>
          {report.vendorHint && (
            <div className="text-muted-foreground">
              {report.vendorHint.note}
            </div>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 mt-1 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 mt-1 text-muted-foreground shrink-0" />
        )}
      </button>
      {expanded && (
        <ul className="mt-2 space-y-1 border-t border-border/50 pt-2">
          {report.checks.map((check) => (
            <li key={check.id} className="flex items-start gap-2">
              <span
                className={cn(
                  "font-mono shrink-0 w-3",
                  checkStatusClass(check.status)
                )}
                aria-hidden
              >
                {checkStatusSymbol(check.status)}
              </span>
              <div className="min-w-0 flex-1">
                <span className="font-medium text-foreground">
                  {check.label}
                </span>
                <span className="text-muted-foreground"> — {check.detail}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GuidanceCallout({
  guidance,
  onConfigure,
  onReset,
}: {
  guidance: XAAErrorGuidance;
  onConfigure?: () => void;
  onReset?: () => void;
}) {
  const toneClass =
    guidance.severity === "error"
      ? "border-red-500/40 bg-red-500/5"
      : "border-amber-500/40 bg-amber-500/5";
  const iconClass =
    guidance.severity === "error" ? "text-red-500" : "text-amber-500";

  const handleAction = (action: XAAErrorAction) => {
    if (action.intent === "configure") onConfigure?.();
    else if (action.intent === "reset") onReset?.();
    else if (action.intent === "link" && action.href) {
      window.open(action.href, "_blank", "noopener,noreferrer");
    }
  };

  const actionDisabled = (action: XAAErrorAction) => {
    if (action.intent === "configure") return !onConfigure;
    if (action.intent === "reset") return !onReset;
    if (action.intent === "link") return !action.href;
    return true;
  };

  return (
    <div className={cn("rounded-md border px-3 py-2.5 space-y-2", toneClass)}>
      <div className="flex items-start gap-2">
        <AlertCircle className={cn("h-4 w-4 mt-0.5 shrink-0", iconClass)} />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="text-xs font-semibold text-foreground">
            {guidance.title}
          </div>
          <div className="text-xs text-muted-foreground">
            {guidance.explanation}
          </div>
        </div>
      </div>
      {guidance.actions.length > 0 && (
        <div className="flex flex-wrap gap-2 pl-6">
          {guidance.actions.map((action) => (
            <Button
              key={`${action.intent}-${action.label}`}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleAction(action)}
              disabled={actionDisabled(action)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Section header for one phase of the flow. Phases 1–4 are the numbered steps
 * of draft-ietf-oauth-identity-assertion-authz-grant; Phase 0 is MCP
 * discovery, which the spec doesn't define — labelling it as bootstrap keeps
 * the grant itself from looking like it starts at the MCP server.
 */
function PhaseHeader({
  phase,
  skipped,
}: {
  phase: XAAPhaseKey;
  skipped?: boolean;
}) {
  const info = XAA_PHASES[phase];
  const number = getXAAPhaseNumber(phase);
  return (
    <div className="pt-2 first:pt-0" data-testid={`xaa-phase-${phase}`}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Phase {number} · {info.title}
        </span>
        {info.specStep === null ? (
          <Badge variant="outline" className="text-[10px] h-4 px-1.5">
            not part of the XAA grant
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] h-4 px-1.5">
            spec step {info.specStep}
          </Badge>
        )}
        {skipped && (
          <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
            skipped — auth server pre-configured
          </Badge>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{info.blurb}</p>
    </div>
  );
}

/** Short, user-facing labels for the compact progress rail — the full phase
 * titles are too long to sit five-across in the header. */
const PHASE_RAIL_LABELS: Record<XAAPhaseKey, string> = {
  bootstrap: "Discovery",
  sso: "SSO",
  token_exchange: "ID-JAG",
  jwt_bearer: "Access token",
  mcp_request: "MCP call",
};

/** At-a-glance "where am I" rail across the five phases, so the developer
 * keeps their bearings without scrolling the step list. */
function PhaseRail({ currentStep }: { currentStep: XAAFlowStep }) {
  const currentPhase = getXAAStepInfo(currentStep).phase;
  const currentPhaseNumber = currentPhase
    ? getXAAPhaseNumber(currentPhase)
    : -1;
  const isComplete = currentStep === "complete";

  return (
    <div
      className="flex flex-wrap items-center gap-x-1 gap-y-1"
      aria-label="XAA flow progress"
    >
      {XAA_PHASE_ORDER.map((phase, index) => {
        const number = getXAAPhaseNumber(phase);
        const state =
          isComplete || number < currentPhaseNumber
            ? "done"
            : number === currentPhaseNumber
            ? "active"
            : "pending";
        return (
          <Fragment key={phase}>
            {index > 0 && (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
            )}
            <span
              data-testid={`xaa-rail-${phase}`}
              data-state={state}
              className={cn(
                "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]",
                state === "active" &&
                  "bg-blue-500/10 font-medium text-blue-600 dark:text-blue-400",
                state === "done" && "text-green-600 dark:text-green-400",
                state === "pending" && "text-muted-foreground"
              )}
            >
              {state === "done" ? (
                <CheckCircle2 className="h-3 w-3 shrink-0" />
              ) : (
                <span className="font-mono">{number}</span>
              )}
              {PHASE_RAIL_LABELS[phase]}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Outcome banner for a negative-mode run: a rejection is the pass condition
 * (green), an accepted broken assertion is the security risk (red). Without
 * this, a (correct) rejection rendered as a generic red error and looked like
 * a failure — the opposite of what the scorecard reports. */
function NegativeProbeCallout({
  probe,
  mode,
}: {
  probe: NonNullable<XAAFlowState["negativeProbe"]>;
  mode: NegativeTestMode;
}) {
  const label = NEGATIVE_TEST_MODE_DETAILS[mode]?.label ?? "negative test";

  if (probe.outcome === "rejected") {
    return (
      <div className="rounded-md border border-green-500/40 bg-green-500/5 px-3 py-2.5 text-xs">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
          <div className="min-w-0 space-y-1">
            <div className="font-medium text-foreground">
              Correctly rejected — exactly what should happen
            </div>
            <div className="text-muted-foreground">
              Your authorization server rejected the {label} assertion
              {probe.status ? ` with HTTP ${probe.status}` : ""}. In a negative
              test a rejection is the pass condition — the same result the
              scorecard reports as a pass.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2.5 text-xs">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
        <div className="min-w-0 space-y-1">
          <div className="font-medium text-foreground">
            Accepted a broken assertion — security risk
          </div>
          <div className="text-muted-foreground">
            Your authorization server issued an access token for the {label}{" "}
            assertion
            {probe.status ? ` (HTTP ${probe.status})` : ""}. It should have
            rejected it — this is the failure the negative test checks for.
          </div>
        </div>
      </div>
    </div>
  );
}

/** A "Tip" callout — visually distinct from diagnostics so static teaching
 * copy can't be mistaken for an error explanation. */
function TeachableMoments({ moments }: { moments: string[] }) {
  return (
    <div className="space-y-1.5 border-l-2 border-blue-400/40 pl-3">
      {moments.map((moment) => (
        <p
          key={moment}
          className="flex items-start gap-1.5 text-xs text-muted-foreground"
        >
          <Lightbulb className="h-3.5 w-3.5 mt-px shrink-0 text-blue-400" />
          <span>{moment}</span>
        </p>
      ))}
    </div>
  );
}

export function XAAFlowLogger({
  flowState,
  hasProfile,
  activeStep,
  onFocusStep,
  actions,
  summary,
}: XAAFlowLoggerProps) {
  const [expandedSteps, setExpandedSteps] = useState<Set<XAAFlowStep>>(
    new Set()
  );

  const stepRefs = useRef(new Map<XAAFlowStep, HTMLDivElement | null>());

  useEffect(() => {
    setExpandedSteps(new Set([flowState.currentStep]));
  }, [flowState.currentStep]);

  // Bring the focused step (e.g. clicked in the run rail or the diagram) into
  // view and open it, so focusing actually navigates to that step's card.
  useEffect(() => {
    if (!activeStep) return;
    setExpandedSteps((previous) => {
      if (previous.has(activeStep)) return previous;
      const next = new Set(previous);
      next.add(activeStep);
      return next;
    });
    stepRefs.current
      .get(activeStep)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeStep]);

  const groups = useMemo(() => {
    const steps = new Map<
      XAAFlowStep,
      {
        step: XAAFlowStep;
        infoEntries: NonNullable<XAAFlowState["infoLogs"]>;
        httpEntries: NonNullable<XAAFlowState["httpHistory"]>;
      }
    >();

    const ensureGroup = (step: XAAFlowStep) => {
      if (!steps.has(step)) {
        steps.set(step, {
          step,
          infoEntries: [],
          httpEntries: [],
        });
      }

      return steps.get(step)!;
    };

    (flowState.infoLogs || []).forEach((entry) => {
      ensureGroup(entry.step as XAAFlowStep).infoEntries.push(entry);
    });

    (flowState.httpHistory || []).forEach((entry) => {
      ensureGroup(entry.step as XAAFlowStep).httpEntries.push(entry);
    });

    return Array.from(steps.values()).sort(
      (a, b) => getXAAStepIndex(a.step) - getXAAStepIndex(b.step)
    );
  }, [flowState.httpHistory, flowState.infoLogs]);

  // Bucket consecutive step groups by phase so each phase renders one header.
  const phasedGroups = useMemo(() => {
    const sections: {
      phase: XAAPhaseKey | undefined;
      groups: typeof groups;
    }[] = [];
    for (const group of groups) {
      const phase = getXAAStepInfo(group.step).phase;
      const last = sections[sections.length - 1];
      if (last && last.phase === phase) {
        last.groups.push(group);
      } else {
        sections.push({ phase, groups: [group] });
      }
    }
    return sections;
  }, [groups]);

  const currentStepIndex = getXAAStepIndex(flowState.currentStep);
  const negativeModeSummary =
    NEGATIVE_TEST_MODE_DETAILS[summary.negativeTestMode];

  const toggleStep = (step: XAAFlowStep) => {
    setExpandedSteps((previous) => {
      const next = new Set(previous);
      if (next.has(step)) {
        next.delete(step);
      } else {
        next.add(step);
      }
      return next;
    });
  };

  const getStatus = (step: XAAFlowStep) => {
    const index = getXAAStepIndex(step);
    // A negative-mode run ends at the step it reached: an accepted broken
    // assertion is a failure (red), a rejection is the expected success
    // (green). Without this the step icon would read "complete" next to the
    // red security-risk banner.
    if (flowState.negativeProbe && step === flowState.currentStep) {
      if (flowState.negativeProbe.outcome === "accepted") {
        return {
          icon: AlertTriangle,
          className: "h-4 w-4 text-red-500",
          label: "Failed",
        };
      }
      return {
        icon: CheckCircle2,
        className: "h-4 w-4 text-green-600 dark:text-green-400",
        label: "Complete",
      };
    }
    if (flowState.isBusy && step === flowState.currentStep) {
      return {
        icon: Loader2,
        className: "h-4 w-4 text-blue-500 animate-spin",
        label: "In progress",
      };
    }

    if (
      index < currentStepIndex ||
      (!flowState.isBusy && index <= currentStepIndex)
    ) {
      return {
        icon: CheckCircle2,
        className: "h-4 w-4 text-green-600 dark:text-green-400",
        label: "Complete",
      };
    }

    if (index === currentStepIndex + 1) {
      return {
        icon: Circle,
        className: "h-4 w-4 text-blue-500",
        label: "Next",
      };
    }

    return {
      icon: Circle,
      className: "h-4 w-4 text-muted-foreground",
      label: "Pending",
    };
  };

  return (
    <div className="h-full min-w-0 border-l border-border flex flex-col">
      <div className="@container/xaa-run-bar bg-muted/30 border-b border-border px-4 py-3 space-y-3">
        <div className="flex flex-col gap-2 @min-[384px]/xaa-run-bar:flex-row @min-[384px]/xaa-run-bar:items-center">
          <button
            onClick={actions.onConfigure}
            className="flex w-full min-w-0 items-center gap-2 text-left border border-border hover:border-foreground/30 bg-background rounded-md px-3 py-2 transition-colors cursor-pointer group @min-[384px]/xaa-run-bar:flex-1"
          >
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {summary.serverUrl || "Configure an MCP server URL to start."}
            </p>
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">
              <Pencil className="h-3 w-3" />
              Edit
            </span>
          </button>
          {hasProfile && (
            <div className="flex shrink-0 items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={actions.onReset}
                disabled={actions.resetDisabled || !actions.onReset}
                className="h-7"
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Reset
              </Button>
              <div className="flex items-stretch">
                <Button
                  size="sm"
                  onClick={actions.onContinue}
                  disabled={
                    actions.continueDisabled ||
                    !actions.onContinue ||
                    actions.isRunningAll
                  }
                  className={cn("h-7", actions.onRunAll && "rounded-r-none")}
                >
                  {actions.isRunningAll ? (
                    <>
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      Running
                    </>
                  ) : (
                    actions.continueLabel
                  )}
                </Button>
                {actions.onRunAll && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        aria-label="More run options"
                        disabled={actions.isRunningAll}
                        className="h-7 rounded-l-none border-l border-primary-foreground/25 px-1.5"
                      >
                        <ChevronDown className="h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={actions.onRunAll}
                        disabled={actions.runAllDisabled}
                      >
                        <Play className="mr-2 h-3.5 w-3.5" />
                        Run all
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </div>
          )}
        </div>

        {hasProfile && (
          <>
            <PhaseRail currentStep={flowState.currentStep} />

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Mode</span>
                <Select
                  value={summary.negativeTestMode}
                  onValueChange={(nextValue) =>
                    actions.onChangeNegativeTestMode?.(
                      nextValue as NegativeTestMode
                    )
                  }
                  disabled={!actions.onChangeNegativeTestMode}
                >
                  <SelectTrigger className="h-7 w-[180px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {NEGATIVE_TEST_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode} className="text-xs">
                        {NEGATIVE_TEST_MODE_DETAILS[mode].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {summary.clientId && (
                <Badge variant="outline" className="text-xs">
                  {summary.clientId}
                </Badge>
              )}
              {summary.scope && (
                <Badge variant="outline" className="text-xs">
                  {summary.scope}
                </Badge>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              {negativeModeSummary.description}
            </p>
          </>
        )}
      </div>

      <div className="flex-1 overflow-auto bg-muted/30 p-4 space-y-4">
        {hasProfile && flowState.compatibilityReport && (
          <CompatibilityBanner report={flowState.compatibilityReport} />
        )}

        {flowState.negativeProbe && (
          <NegativeProbeCallout
            probe={flowState.negativeProbe}
            mode={flowState.negativeTestMode}
          />
        )}

        {(() => {
          const currentStepHttpEntries = (flowState.httpHistory || []).filter(
            (entry) => entry.step === flowState.currentStep
          );
          const currentStepErroredEntry = latestErroredHttpEntry(
            currentStepHttpEntries
          );
          if (!flowState.error && !currentStepErroredEntry) return null;
          const guidance = getXAAErrorGuidance({
            step: flowState.currentStep,
            stateError: flowState.error,
            httpEntry: currentStepErroredEntry,
          });
          if (guidance) {
            return (
              <GuidanceCallout
                guidance={guidance}
                onConfigure={actions.onConfigure}
                onReset={actions.onReset}
              />
            );
          }
          if (flowState.error) {
            return (
              <Alert variant="destructive" className="py-2">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  {flowState.error}
                </AlertDescription>
              </Alert>
            );
          }
          return null;
        })()}

        {flowState.idJag && flowState.idJagDecoded && (
          <IdJagInspector
            rawJwt={flowState.idJag}
            decoded={flowState.idJagDecoded}
            negativeTestMode={flowState.negativeTestMode}
            lintContext={{
              expectedAudience:
                flowState.authzMetadata?.issuer || flowState.authzServerIssuer,
              expectedResource:
                flowState.resourceMetadata?.resource || flowState.resourceUrl,
              expectedClientId: flowState.clientId,
            }}
          />
        )}

        {!hasProfile ? (
          <div className="bg-background border border-border rounded-lg p-6 space-y-4">
            <div className="space-y-1.5">
              <h3 className="text-base font-semibold">
                Welcome to the XAA Debugger
              </h3>
              <p className="text-sm text-muted-foreground">
                Cross-app access (XAA) lets one app call another app&apos;s MCP
                server on a user&apos;s behalf — without a second login. Step
                through that flow here and see exactly where your authorization
                server accepts or rejects it.
              </p>
            </div>

            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground marker:font-medium marker:text-foreground">
              <li>
                <span className="font-medium text-foreground">
                  Pick a server to test
                </span>{" "}
                — add or pick one in the bar above (each environment —
                beta/staging/prod — is its own server), then set the simulated
                user and test mode in the run bar.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  Trust MCPJam at your auth server
                </span>{" "}
                — MCPJam acts as the identity provider. Register its Issuer and
                JWKS URLs (the card at the top) so your authorization server
                accepts the tokens MCPJam signs. Do this first, or the next step
                gets rejected.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  Run the flow
                </span>{" "}
                — MCPJam mints an ID-JAG (a signed assertion of who the user
                is); your authorization server exchanges it for an access token.
                Advance one step at a time to inspect each request.
              </li>
            </ol>
          </div>
        ) : groups.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm">
            No activity yet. Click &quot;{actions.continueLabel}&quot; to begin.
          </div>
        ) : (
          phasedGroups.map((section) => (
            <div key={section.phase ?? "no-phase"} className="space-y-3">
              {section.phase && (
                <PhaseHeader
                  phase={section.phase}
                  skipped={
                    section.phase === "bootstrap" &&
                    Boolean(summary.authzServerIssuer) &&
                    section.groups.every(
                      (group) => group.httpEntries.length === 0
                    )
                  }
                />
              )}
              {section.groups.map((group, indexInPhase) => {
                const stepInfo = getXAAStepInfo(group.step);
                const status = getStatus(group.step);
                const StatusIcon = status.icon;
                const entryCount =
                  group.infoEntries.length + group.httpEntries.length;
                const hasError = group.httpEntries.some((entry) => entry.error);
                const stepLabel = section.phase
                  ? `${getXAAPhaseNumber(section.phase)}.${indexInPhase + 1} ${
                      stepInfo.title
                    }`
                  : stepInfo.title;

                return (
                  <div
                    key={group.step}
                    ref={(el) => {
                      stepRefs.current.set(group.step, el);
                    }}
                    className="bg-background border border-border rounded-lg shadow-sm"
                  >
                    <button
                      onClick={() => toggleStep(group.step)}
                      className="w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-muted/40 rounded-t-lg"
                    >
                      <div className="flex-shrink-0 mt-0.5">
                        {expandedSteps.has(group.step) ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                      <StatusIcon className={status.className} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-semibold">
                            {stepLabel}
                          </span>
                          <Badge
                            variant="secondary"
                            className="text-[10px] h-4 px-1.5"
                          >
                            {entryCount}
                          </Badge>
                          {hasError && (
                            <Badge
                              variant="destructive"
                              className="text-[10px] h-4 px-1.5"
                            >
                              Error
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {stepInfo.summary}
                        </p>
                      </div>
                      {onFocusStep && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7"
                          onClick={(event) => {
                            event.stopPropagation();
                            onFocusStep(group.step);
                          }}
                        >
                          Focus
                        </Button>
                      )}
                    </button>

                    {expandedSteps.has(group.step) && (
                      <div className="border-t bg-muted/20 p-4 space-y-3">
                        {(() => {
                          if (group.step === flowState.currentStep) {
                            // Top-level callout covers the current step.
                            return null;
                          }
                          const erroredEntry = latestErroredHttpEntry(
                            group.httpEntries
                          );
                          if (!erroredEntry) return null;
                          const guidance = getXAAErrorGuidance({
                            step: group.step,
                            httpEntry: erroredEntry,
                          });
                          if (!guidance) return null;
                          return (
                            <GuidanceCallout
                              guidance={guidance}
                              onConfigure={actions.onConfigure}
                              onReset={actions.onReset}
                            />
                          );
                        })()}

                        {group.infoEntries.map((entry) => (
                          <InfoLogEntry
                            key={entry.id}
                            label={entry.label}
                            timestamp={entry.timestamp}
                            data={entry.data}
                            level={entry.level}
                            error={entry.error}
                          />
                        ))}

                        {group.httpEntries.map((entry) => (
                          <HTTPHistoryEntry
                            key={`${entry.timestamp}-${entry.request.url}`}
                            method={entry.request.method}
                            url={entry.request.url}
                            status={entry.response?.status}
                            statusText={entry.response?.statusText}
                            duration={entry.duration}
                            requestHeaders={entry.request.headers}
                            requestBody={entry.request.body}
                            responseHeaders={entry.response?.headers}
                            responseBody={entry.response?.body}
                            error={entry.error}
                            step={entry.step}
                          />
                        ))}

                        {stepInfo.teachableMoments?.length ? (
                          <TeachableMoments
                            moments={stepInfo.teachableMoments}
                          />
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}

        {hasProfile &&
          groups.length > 0 &&
          flowState.currentStep !== "complete" && (
            <div className="text-xs text-muted-foreground">
              Remaining steps:{" "}
              {
                XAA_STEP_ORDER.filter(
                  (step) => getXAAStepIndex(step) > currentStepIndex
                ).length
              }
            </div>
          )}
      </div>
    </div>
  );
}
