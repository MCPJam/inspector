import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  KeyRound,
  Loader2,
  Pencil,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Alert, AlertDescription } from "@mcpjam/design-system/alert";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
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
  getXAAStepInfo,
  getXAAStepIndex,
  XAA_STEP_ORDER,
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
    onChangeNegativeTestMode?: (mode: NegativeTestMode) => void;
    onShowBootstrap?: () => void;
    continueLabel: string;
    continueDisabled?: boolean;
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

function CompatibilityBanner({
  report,
}: {
  report: XAACompatibilityReport;
}) {
  const [expanded, setExpanded] = useState(report.overall !== "pass");

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
        tone.bgClass,
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
                  checkStatusClass(check.status),
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
  onShowBootstrap,
  onReset,
}: {
  guidance: XAAErrorGuidance;
  onConfigure?: () => void;
  onShowBootstrap?: () => void;
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
    else if (action.intent === "bootstrap") onShowBootstrap?.();
    else if (action.intent === "reset") onReset?.();
    else if (action.intent === "link" && action.href) {
      window.open(action.href, "_blank", "noopener,noreferrer");
    }
  };

  const actionDisabled = (action: XAAErrorAction) => {
    if (action.intent === "configure") return !onConfigure;
    if (action.intent === "bootstrap") return !onShowBootstrap;
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


export function XAAFlowLogger({
  flowState,
  hasProfile,
  activeStep,
  onFocusStep,
  actions,
  summary,
}: XAAFlowLoggerProps) {
  const [expandedSteps, setExpandedSteps] = useState<Set<XAAFlowStep>>(
    new Set(),
  );

  useEffect(() => {
    setExpandedSteps(new Set([flowState.currentStep]));
  }, [flowState.currentStep]);

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
      (a, b) => getXAAStepIndex(a.step) - getXAAStepIndex(b.step),
    );
  }, [flowState.httpHistory, flowState.infoLogs]);

  const currentStepIndex = getXAAStepIndex(flowState.currentStep);
  const focusedStep = activeStep ?? flowState.currentStep;
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
    if (flowState.isBusy && step === flowState.currentStep) {
      return {
        icon: Loader2,
        className: "h-4 w-4 text-blue-500 animate-spin",
        label: "In progress",
      };
    }

    if (index < currentStepIndex || (!flowState.isBusy && index <= currentStepIndex)) {
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
    <div className="h-full border-l border-border flex flex-col">
      <div className="bg-muted/30 border-b border-border px-4 py-3 space-y-3">
        <div className="flex items-center gap-2">
          <button
            onClick={actions.onConfigure}
            className="min-w-0 flex-1 flex items-center gap-2 text-left border border-border hover:border-foreground/30 bg-background rounded-md px-3 py-2 transition-colors cursor-pointer group"
          >
            <p className="text-sm font-medium text-foreground break-all flex-1">
              {summary.serverUrl || "Configure an MCP server URL to start."}
            </p>
            <span className="flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground shrink-0">
              <Pencil className="h-3 w-3" />
              Edit
            </span>
          </button>
          <div className="flex items-center gap-1 shrink-0">
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
            <Button
              size="sm"
              onClick={actions.onContinue}
              disabled={actions.continueDisabled || !actions.onContinue}
              className="h-7"
            >
              {actions.continueLabel}
            </Button>
          </div>
        </div>

        {hasProfile && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Mode</span>
                <Select
                  value={summary.negativeTestMode}
                  onValueChange={(nextValue) =>
                    actions.onChangeNegativeTestMode?.(
                      nextValue as NegativeTestMode,
                    )
                  }
                  disabled={!actions.onChangeNegativeTestMode}
                >
                  <SelectTrigger className="h-7 w-[180px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {NEGATIVE_TEST_MODES.map((mode) => (
                      <SelectItem
                        key={mode}
                        value={mode}
                        className="text-xs"
                      >
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
              {actions.onShowBootstrap && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7 text-xs"
                  onClick={actions.onShowBootstrap}
                >
                  <KeyRound className="h-3 w-3 mr-1" />
                  Register issuer
                </Button>
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

        {(() => {
          const currentStepHttpEntries = (flowState.httpHistory || []).filter(
            (entry) => entry.step === flowState.currentStep,
          );
          const currentStepErroredEntry = latestErroredHttpEntry(
            currentStepHttpEntries,
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
                onShowBootstrap={actions.onShowBootstrap}
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
          />
        )}

        {!hasProfile ? (
          <div className="bg-background border border-border rounded-lg p-6 space-y-3">
            <h3 className="text-base font-semibold">Welcome to the XAA Debugger</h3>
            <p className="text-sm text-muted-foreground">
              Configure an MCP server, target authorization server, and client ID
              to step through the full enterprise authorization flow.
            </p>
            <Button onClick={actions.onConfigure}>Configure Target</Button>
          </div>
        ) : groups.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm">
            No activity yet. Click &quot;{actions.continueLabel}&quot; to begin.
          </div>
        ) : (
          groups.map((group, index) => {
            const stepInfo = getXAAStepInfo(group.step);
            const status = getStatus(group.step);
            const StatusIcon = status.icon;
            const entryCount =
              group.infoEntries.length + group.httpEntries.length;
            const hasError = group.httpEntries.some((entry) => entry.error);

            return (
              <div
                key={group.step}
                className={cn(
                  "bg-background border rounded-lg shadow-sm",
                  focusedStep === group.step
                    ? "border-blue-400 ring-1 ring-blue-400/20"
                    : "border-border",
                )}
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
                        {index + 1}. {stepInfo.title}
                      </span>
                      <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
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
                    {stepInfo.teachableMoments?.length ? (
                      <div className="space-y-1">
                        {stepInfo.teachableMoments.map((moment) => (
                          <p
                            key={moment}
                            className="text-xs text-muted-foreground"
                          >
                            {moment}
                          </p>
                        ))}
                      </div>
                    ) : null}

                    {(() => {
                      if (group.step === flowState.currentStep) {
                        // Top-level callout covers the current step.
                        return null;
                      }
                      const erroredEntry = latestErroredHttpEntry(
                        group.httpEntries,
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
                          onShowBootstrap={actions.onShowBootstrap}
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
                  </div>
                )}
              </div>
            );
          })
        )}

        {hasProfile && groups.length > 0 && flowState.currentStep !== "complete" && (
          <div className="text-xs text-muted-foreground">
            Remaining steps:{" "}
            {
              XAA_STEP_ORDER.filter(
                (step) => getXAAStepIndex(step) > currentStepIndex,
              ).length
            }
          </div>
        )}
      </div>
    </div>
  );
}
