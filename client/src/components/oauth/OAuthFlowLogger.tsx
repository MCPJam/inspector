import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HTTPHistoryEntry } from "@/components/HTTPHistoryEntry";
import {
  getStepInfo,
  getStepIndex,
} from "@/lib/oauth/state-machines/shared/step-metadata";
import {
  type OAuthFlowState,
  type OAuthFlowStep,
} from "@/lib/oauth/state-machines/types";
import { AlertCircle, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import JsonView from "react18-json-view";
import "react18-json-view/src/dark.css";
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
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set());
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

  const toggleExpanded = (id: string) => {
    setExpandedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleClearAll = () => {
    onClearLogs();
    onClearHttpHistory();
    setExpandedBlocks(new Set());
    setDeletedInfoLogs(new Set());
  };

  const renderStatusBadge = (step: OAuthFlowStep) => {
    const index = getStepIndex(step);
    const labelAndTone = (() => {
      if (index === Number.MAX_SAFE_INTEGER) {
        return {
          label: "Pending",
          tone: "border-border bg-muted text-muted-foreground",
        };
      }

      if (index <= currentStepIndex) {
        return {
          label: "Complete",
          tone: "border-green-500/40 bg-green-500/10 text-green-600",
        };
      }

      if (index === currentStepIndex + 1) {
        return {
          label: "In Progress",
          tone: "border-blue-500/40 bg-blue-500/10 text-blue-600",
        };
      }

      return {
        label: "Pending",
        tone: "border-border bg-muted text-muted-foreground",
      };
    })();

    return (
      <Badge className={`border ${labelAndTone.tone} text-[10px] font-medium`}>
        {labelAndTone.label}
      </Badge>
    );
  };

  return (
    <div className="h-full border-l border-border flex flex-col">
      <div
        ref={scrollContainerRef}
        className="h-full bg-muted/30 overflow-auto"
      >
        <div className="sticky top-0 z-10 bg-muted/30 backdrop-blur-sm border-b border-border px-4 py-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">OAuth Flow Guide</h3>
          <button
            onClick={handleClearAll}
            className="p-1 hover:bg-muted rounded transition-colors"
            title="Clear all logs"
          >
            <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {oauthFlowState.error && (
            <Alert variant="destructive" className="py-2">
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
              const infoEntries = group.entries.filter(
                (entry) => entry.type === "info",
              );
              const httpEntries = group.entries.filter(
                (entry) => entry.type === "http",
              );

              return (
                <div
                  key={group.step}
                  className={`border rounded-lg bg-card/80 shadow-sm transition-shadow ${isActive ? "border-blue-400 shadow-md" : "border-border"}`}
                >
                  <div className="px-4 py-3 border-b border-border/70 bg-muted/40 flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2 justify-between">
                      <div className="flex items-center gap-2">
                        <Badge className="text-[10px] uppercase tracking-wide bg-primary/10 text-primary">
                          Step {stepNumber}
                        </Badge>
                        <h4 className="text-sm font-semibold text-foreground">
                          {info.title}
                        </h4>
                        {renderStatusBadge(group.step)}
                      </div>
                      {onFocusStep && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          onClick={() => onFocusStep(group.step)}
                        >
                          Show in diagram
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {info.summary}
                    </p>
                    {info.teachableMoments &&
                      info.teachableMoments.length > 0 && (
                        <div className="bg-background/70 border border-border/70 rounded-md p-3">
                          <p className="text-[11px] font-semibold text-foreground mb-2">
                            What to pay attention to
                          </p>
                          <ul className="list-disc pl-4 space-y-1">
                            {info.teachableMoments.map((item) => (
                              <li
                                key={item}
                                className="text-[11px] text-muted-foreground"
                              >
                                {item}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    {info.tips && info.tips.length > 0 && (
                      <div className="bg-yellow-50/80 dark:bg-yellow-900/20 border border-yellow-200/60 dark:border-yellow-800/60 rounded-md p-3">
                        <p className="text-[11px] font-semibold text-yellow-900 dark:text-yellow-200 mb-1">
                          Tips
                        </p>
                        <ul className="list-disc pl-4 space-y-1">
                          {info.tips.map((tip) => (
                            <li
                              key={tip}
                              className="text-[11px] text-yellow-900/80 dark:text-yellow-100"
                            >
                              {tip}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  <div className="p-4 space-y-3">
                    {infoEntries.map(({ log }) => {
                      const isExpanded = expandedBlocks.has(log.id);
                      return (
                        <div
                          key={log.id}
                          className="border rounded-md bg-background/80"
                        >
                          <button
                            type="button"
                            className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-muted/60 transition-colors"
                            onClick={() => toggleExpanded(log.id)}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            )}
                            <span className="text-xs font-medium text-foreground">
                              {log.label}
                            </span>
                            <span className="ml-auto text-[11px] text-muted-foreground">
                              {new Date(log.timestamp).toLocaleTimeString()}
                            </span>
                          </button>
                          {isExpanded && (
                            <div className="border-t bg-muted/20">
                              <div className="p-3">
                                <div className="max-h-[36vh] overflow-auto rounded-sm bg-background/60 p-2">
                                  <JsonView
                                    src={log.data}
                                    dark={true}
                                    theme="atom"
                                    enableClipboard={true}
                                    displaySize={false}
                                    collapsed={false}
                                    style={{
                                      fontSize: "11px",
                                      fontFamily:
                                        "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                                      backgroundColor: "transparent",
                                      padding: "0",
                                      borderRadius: "0",
                                      border: "none",
                                    }}
                                  />
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}

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
                      />
                    ))}

                    {infoEntries.length === 0 && httpEntries.length === 0 && (
                      <div className="text-center text-xs text-muted-foreground">
                        No activity recorded for this step yet.
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
