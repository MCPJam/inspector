import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  Pencil,
  RotateCcw,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HTTPHistoryEntry } from "@/components/oauth/HTTPHistoryEntry";
import { InfoLogEntry } from "@/components/oauth/InfoLogEntry";
import { IdJagInspector } from "./IdJagInspector";
import {
  getXAAStepInfo,
  getXAAStepIndex,
  XAA_STEP_ORDER,
} from "@/lib/xaa/step-metadata";
import type {
  XAAFlowState,
  XAAFlowStep,
} from "@/lib/xaa/types";
import { NEGATIVE_TEST_MODE_DETAILS } from "@/shared/xaa.js";

interface XAAFlowLoggerProps {
  flowState: XAAFlowState;
  hasProfile: boolean;
  activeStep?: XAAFlowStep | null;
  onFocusStep?: (step: XAAFlowStep) => void;
  actions: {
    onConfigure: () => void;
    onReset?: () => void;
    onContinue?: () => void;
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
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary" className="text-xs">
              {negativeModeSummary.label}
            </Badge>
            {summary.authzServerIssuer && (
              <Badge variant="outline" className="text-xs">
                AuthZ issuer set
              </Badge>
            )}
            {summary.clientId && (
              <Badge variant="outline" className="text-xs">
                Client ID set
              </Badge>
            )}
            {summary.scope && (
              <Badge variant="outline" className="text-xs">
                {summary.scope}
              </Badge>
            )}
          </div>
        )}

        {hasProfile && (
          <p className="text-xs text-muted-foreground">
            {negativeModeSummary.description}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-auto bg-muted/30 p-4 space-y-4">
        {flowState.error && (
          <Alert variant="destructive" className="py-2">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              {flowState.error}
            </AlertDescription>
          </Alert>
        )}

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
