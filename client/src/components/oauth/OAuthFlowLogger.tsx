import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HTTPHistoryEntry } from "@/components/oauth/HTTPHistoryEntry";
import { InfoLogEntry } from "@/components/oauth/InfoLogEntry";
import {
  getStepInfo,
  getStepIndex,
} from "@/lib/oauth/state-machines/shared/step-metadata";
import {
  type OAuthFlowState,
  type OAuthFlowStep,
} from "@/lib/oauth/state-machines/types";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  Trash2,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
} from "lucide-react";
import "react18-json-view/src/style.css";

interface OAuthFlowLoggerProps {
  oauthFlowState: OAuthFlowState;
  onClearLogs: () => void;
  onClearHttpHistory: () => void;
  activeStep?: OAuthFlowStep | null;
  onFocusStep?: (step: OAuthFlowStep) => void;
}

export function OAuthFlowLogger({
  oauthFlowState,
  onClearLogs,
  onClearHttpHistory,
  activeStep,
  onFocusStep,
}: OAuthFlowLoggerProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [deletedInfoLogs, setDeletedInfoLogs] = useState<Set<string>>(
    new Set(),
  );

  const groups = useMemo(() => {
    type StepEntry =
      | { type: "info"; log: NonNullable<OAuthFlowState["infoLogs"]>[number] }
      | {
          type: "http";
          entry: NonNullable<OAuthFlowState["httpHistory"]>[number];
        };

    const map = new Map<
      OAuthFlowStep,
      {
        step: OAuthFlowStep;
        entries: StepEntry[];
        firstTimestamp: number;
      }
    >();

    const ensureGroup = (step: OAuthFlowStep) => {
      if (!map.has(step)) {
        map.set(step, {
          step,
          entries: [],
          firstTimestamp: Number.POSITIVE_INFINITY,
        });
      }
      return map.get(step)!;
    };

    (oauthFlowState.infoLogs || [])
      .filter((log) => !deletedInfoLogs.has(log.id))
      .forEach((log) => {
        const group = ensureGroup(log.step);
        group.entries.push({ type: "info", log });
        group.firstTimestamp = Math.min(group.firstTimestamp, log.timestamp);
      });

    (oauthFlowState.httpHistory || []).forEach((entry) => {
      const group = ensureGroup(entry.step);
      group.entries.push({ type: "http", entry });
      group.firstTimestamp = Math.min(group.firstTimestamp, entry.timestamp);
    });

    const ordered = Array.from(map.values());

    ordered.forEach((group) => {
      group.entries.sort((a, b) => {
        const timeA = a.type === "info" ? a.log.timestamp : a.entry.timestamp;
        const timeB = b.type === "info" ? b.log.timestamp : b.entry.timestamp;
        return timeA - timeB;
      });
    });

    ordered.sort((a, b) => {
      const diff = getStepIndex(a.step) - getStepIndex(b.step);
      if (diff !== 0) return diff;
      return a.firstTimestamp - b.firstTimestamp;
    });

    return ordered;
  }, [oauthFlowState.infoLogs, oauthFlowState.httpHistory, deletedInfoLogs]);

  const currentStepIndex = getStepIndex(oauthFlowState.currentStep);
  const focusStep = activeStep ?? oauthFlowState.currentStep;
  const totalEntries = useMemo(
    () =>
      groups.reduce((sum, group) => {
        return sum + group.entries.length;
      }, 0),
    [groups],
  );

  useEffect(() => {
    if (!scrollContainerRef.current) return;
    const container = scrollContainerRef.current;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [totalEntries, oauthFlowState.error]);

  const handleClearAll = () => {
    onClearLogs();
    onClearHttpHistory();
    setDeletedInfoLogs(new Set());
  };

  // Track which steps are expanded (auto-expand current step)
  const [expandedSteps, setExpandedSteps] = useState<Set<OAuthFlowStep>>(
    new Set(),
  );

  // Auto-expand current step
  useEffect(() => {
    setExpandedSteps(new Set([oauthFlowState.currentStep]));
  }, [oauthFlowState.currentStep]);

  const toggleStep = (step: OAuthFlowStep) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(step)) {
        next.delete(step);
      } else {
        next.add(step);
      }
      return next;
    });
  };

  const getStatusIcon = (step: OAuthFlowStep) => {
    const index = getStepIndex(step);

    if (index === Number.MAX_SAFE_INTEGER) {
      return {
        icon: Circle,
        className: "h-4 w-4 text-muted-foreground",
        label: "Pending",
      };
    }

    if (index < currentStepIndex) {
      return {
        icon: CheckCircle2,
        className: "h-4 w-4 text-green-600 dark:text-green-400",
        label: "Complete",
      };
    }

    if (index === currentStepIndex) {
      return {
        icon: CheckCircle2,
        className: "h-4 w-4 text-green-600 dark:text-green-400",
        label: "Complete",
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
      <div
        ref={scrollContainerRef}
        className="h-full bg-muted/30 overflow-auto"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-muted/30 backdrop-blur-sm border-b border-border px-4 py-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">OAuth Flow Guide</h3>
        </div>

        {/* Content */}
        <div className="p-6 space-y-1">
          {oauthFlowState.error && (
            <Alert variant="destructive" className="py-2 mb-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="text-xs">
                {oauthFlowState.error}
              </AlertDescription>
            </Alert>
          )}

          {groups.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No activity yet.
            </div>
          ) : (
            groups.map((group, groupIndex) => {
              const info = getStepInfo(group.step);
              const isActive = focusStep === group.step;
              const stepNumber = groupIndex + 1;
              const isExpanded = expandedSteps.has(group.step);
              const isLastStep = groupIndex === groups.length - 1;

              const infoEntries = group.entries.filter(
                (entry) => entry.type === "info",
              );
              const httpEntries = group.entries.filter(
                (entry) => entry.type === "http",
              );
              const totalEntries = infoEntries.length + httpEntries.length;
              const errorInfoCount = infoEntries.filter(
                ({ log }) => log.level === "error",
              ).length;
              const httpErrorCount = httpEntries.filter(({ entry }) => {
                if (entry.error) return true;
                const status = entry.response?.status;
                if (entry.step === "request_without_token" && status === 401) {
                  return false;
                }
                return typeof status === "number" && status >= 400;
              }).length;
              const errorCount = errorInfoCount + httpErrorCount;
              const hasError = errorCount > 0;
              const firstErrorMessage =
                infoEntries.find(({ log }) => log.level === "error")?.log.error
                  ?.message ||
                httpEntries.find(({ entry }) => entry.error)?.entry.error
                  ?.message ||
                httpEntries.find(({ entry }) => {
                  const status = entry.response?.status;
                  if (
                    entry.step === "request_without_token" &&
                    status === 401
                  ) {
                    return false;
                  }
                  return (
                    typeof status === "number" &&
                    status >= 400 &&
                    !!entry.response?.statusText
                  );
                })?.entry.response?.statusText;
              const statusInfo = getStatusIcon(group.step);
              const StatusIcon = statusInfo.icon;

              return (
                <div key={group.step} className="relative">
                  {/* Timeline connector line */}
                  {!isLastStep && (
                    <div className="absolute left-[11px] top-[32px] bottom-0 w-[2px] bg-border" />
                  )}

                  {/* Step card */}
                  <div
                    className={cn(
                      "relative bg-background border rounded-lg transition-all",
                      hasError
                        ? "border-red-400 ring-1 ring-red-400/20 shadow-md"
                        : isActive
                          ? "border-blue-400 shadow-md ring-1 ring-blue-400/20"
                          : "border-border shadow-sm hover:shadow-md",
                    )}
                  >
                    {/* Step header - clickable */}
                    <button
                      onClick={() => toggleStep(group.step)}
                      className="w-full px-4 py-3 flex items-start gap-3 hover:bg-muted/30 transition-colors rounded-t-lg cursor-pointer"
                    >
                      {/* Status icon */}
                      <div className="flex-shrink-0 mt-0.5">
                        {hasError ? (
                          <AlertCircle className="h-4 w-4 text-red-500" />
                        ) : (
                          <StatusIcon className={statusInfo.className} />
                        )}
                      </div>

                      {/* Step info */}
                      <div className="flex-1 min-w-0 text-left">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-semibold text-foreground">
                            {stepNumber}. {info.title}
                          </span>
                          {totalEntries > 0 && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] h-4 px-1.5"
                            >
                              {totalEntries}
                            </Badge>
                          )}
                          {hasError && (
                            <Badge
                              variant="destructive"
                              className="text-[10px] h-4 px-1.5"
                            >
                              {errorCount} error{errorCount > 1 ? "s" : ""}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {info.summary}
                        </p>
                        {hasError && firstErrorMessage && (
                          <p className="text-xs text-red-600 dark:text-red-400 mt-1 line-clamp-1">
                            {firstErrorMessage}
                          </p>
                        )}
                      </div>

                      {/* Right side actions */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {/* Show in diagram button */}
                        {onFocusStep && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              onFocusStep(group.step);
                            }}
                            className="h-7 px-2 text-xs"
                          >
                            Show in diagram
                          </Button>
                        )}

                        {/* Expand/collapse chevron */}
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </button>

                    {/* Collapsible content */}
                    {isExpanded && (
                      <div className="px-4 pb-4 pt-2 space-y-3 border-t">
                        {/* Educational content */}
                        {(info.teachableMoments || info.tips) && (
                          <div className="space-y-2">
                            {info.teachableMoments &&
                              info.teachableMoments.length > 0 && (
                                <div className="rounded-md border border-border bg-muted/10 p-3">
                                  <p className="text-xs font-semibold text-muted-foreground mb-2">
                                    What to pay attention to
                                  </p>
                                  <ul className="list-disc pl-5 space-y-1">
                                    {info.teachableMoments.map((item) => (
                                      <li
                                        key={item}
                                        className="text-xs text-muted-foreground"
                                      >
                                        {item}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            {info.tips && info.tips.length > 0 && (
                              <div className="rounded-md border border-border bg-muted/10 p-3">
                                <p className="text-xs font-semibold text-muted-foreground mb-2">
                                  Tips
                                </p>
                                <ul className="list-disc pl-5 space-y-1">
                                  {info.tips.map((tip) => (
                                    <li
                                      key={tip}
                                      className="text-xs text-muted-foreground"
                                    >
                                      {tip}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Info logs */}
                        {infoEntries.map(({ log }) => (
                          <InfoLogEntry
                            key={log.id}
                            label={log.label}
                            timestamp={log.timestamp}
                            data={log.data}
                            level={log.level ?? "info"}
                            error={log.error}
                          />
                        ))}

                        {/* HTTP requests */}
                        {httpEntries.map(({ entry }) => (
                          <HTTPHistoryEntry
                            key={`http-${entry.timestamp}`}
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

                        {/* Empty state */}
                        {infoEntries.length === 0 &&
                          httpEntries.length === 0 && (
                            <div className="text-center text-xs text-muted-foreground py-4">
                              No activity recorded for this step yet.
                            </div>
                          )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
