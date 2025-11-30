import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HTTPHistoryEntry } from "@/components/oauth/HTTPHistoryEntry";
import { InfoLogEntry } from "@/components/oauth/InfoLogEntry";
import {
  getStepInfo,
  getStepIndex,
} from "@/lib/oauth/state-machines/shared/step-metadata";
import {
  type HttpHistoryEntry,
  type OAuthFlowState,
  type OAuthFlowStep,
} from "@/lib/oauth/state-machines/types";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  AlertTriangle,
  Copy,
  RotateCcw,
  Settings,
} from "lucide-react";
import { generateGuideText, generateRawText } from "@/lib/oauth/log-formatters";
import "react18-json-view/src/style.css";

interface OAuthFlowLoggerProps {
  oauthFlowState: OAuthFlowState;
  onClearLogs: () => void;
  onClearHttpHistory: () => void;
  activeStep?: OAuthFlowStep | null;
  onFocusStep?: (step: OAuthFlowStep) => void;
  summary?: {
    label: string;
    description: string;
    protocol?: string;
    registration?: string;
    step?: OAuthFlowStep;
  };
  actions?: {
    onConfigure?: () => void;
    onReset?: () => void;
    onContinue?: () => void;
    continueLabel?: string;
    continueDisabled?: boolean;
    resetDisabled?: boolean;
    onConnectServer?: () => void;
    onRefreshTokens?: () => void;
    isApplyingTokens?: boolean;
  };
}

export function OAuthFlowLogger({
  oauthFlowState,
  onClearLogs: _onClearLogs,
  onClearHttpHistory: _onClearHttpHistory,
  activeStep,
  onFocusStep,
  summary,
  actions,
}: OAuthFlowLoggerProps) {
  const guideScrollRef = useRef<HTMLDivElement | null>(null);
  const rawScrollRef = useRef<HTMLDivElement | null>(null);
  const [deletedInfoLogs] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<"guide" | "raw">("guide");
  const [copySuccess, setCopySuccess] = useState(false);

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
  const formatTimestamp = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString();
  const totalEntries = useMemo(
    () =>
      groups.reduce((sum, group) => {
        return sum + group.entries.length;
      }, 0),
    [groups],
  );

  const timelineEntries = useMemo(() => {
    type TimelineEntry =
      | {
          type: "info";
          timestamp: number;
          log: NonNullable<OAuthFlowState["infoLogs"]>[number];
          key: string;
        }
      | {
          type: "http";
          timestamp: number;
          entry: NonNullable<OAuthFlowState["httpHistory"]>[number];
          key: string;
        };

    const items: TimelineEntry[] = [];

    (oauthFlowState.infoLogs || [])
      .filter((log) => !deletedInfoLogs.has(log.id))
      .forEach((log) => {
        items.push({
          type: "info",
          timestamp: log.timestamp,
          log,
          key: `info-${log.id}`,
        });
      });

    (oauthFlowState.httpHistory || []).forEach((entry, index) => {
      items.push({
        type: "http",
        timestamp: entry.timestamp,
        entry,
        key: `http-${entry.timestamp}-${index}`,
      });
    });

    items.sort((a, b) => {
      if (a.timestamp === b.timestamp) {
        return a.key.localeCompare(b.key);
      }
      return a.timestamp - b.timestamp;
    });

    return items;
  }, [oauthFlowState.infoLogs, oauthFlowState.httpHistory, deletedInfoLogs]);

  const totalTimelineEntries = timelineEntries.length;

  useEffect(() => {
    const container =
      activeTab === "raw" ? rawScrollRef.current : guideScrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [activeTab, totalEntries, totalTimelineEntries, oauthFlowState.error]);

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

  const handleCopyLogs = async () => {
    try {
      const text =
        activeTab === "guide"
          ? generateGuideText(oauthFlowState, groups)
          : generateRawText(oauthFlowState, timelineEntries);
      await navigator.clipboard.writeText(text);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error("Failed to copy logs:", err);
    }
  };

  return (
    <div className="h-full border-l border-border flex flex-col">
      <div className="bg-muted/30 border-b border-border px-4 py-3 space-y-3">
        {summary && (
          <div className="flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-3 min-w-0 text-muted-foreground">
              <p className="text-sm font-medium text-foreground truncate">
                {summary.label}
              </p>
              {summary.protocol && (
                <span className="rounded-full bg-background px-2 py-1 whitespace-nowrap">
                  {summary.protocol}
                </span>
              )}
              {summary.registration && (
                <span className="rounded-full bg-background px-2 py-1 whitespace-nowrap">
                  {summary.registration}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {actions?.onConnectServer && (
                <Button
                  size="sm"
                  onClick={actions.onConnectServer}
                  disabled={actions.isApplyingTokens}
                >
                  {actions.isApplyingTokens ? "Connecting..." : "Connect Server"}
                </Button>
              )}
              {actions?.onRefreshTokens && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={actions.onRefreshTokens}
                  disabled={actions.isApplyingTokens}
                >
                  {actions.isApplyingTokens ? "Refreshing..." : "Refresh Tokens"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={actions?.onConfigure}
                disabled={!actions?.onConfigure}
                aria-label="Configure target"
              >
                <Settings className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={actions?.onReset}
                disabled={actions?.resetDisabled || !actions?.onReset}
                aria-label="Reset flow"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
              {actions?.onContinue && (
                <Button
                  size="sm"
                  onClick={actions.onContinue}
                  disabled={actions.continueDisabled}
                >
                  {actions.continueLabel || "Continue"}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as "guide" | "raw")}
        className="flex-1 overflow-hidden"
      >
        <div className="px-4 pt-2 flex items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="guide">Guide</TabsTrigger>
            <TabsTrigger value="raw">Raw</TabsTrigger>
          </TabsList>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyLogs}
            className="h-8"
          >
            <Copy className="h-3.5 w-3.5 mr-2" />
            {copySuccess ? "Copied!" : "Copy logs"}
          </Button>
        </div>

        <TabsContent value="guide" className="flex-1 overflow-hidden">
          <div
            ref={guideScrollRef}
            className="h-full bg-muted/30 overflow-auto"
          >
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

                  // Check for deprecated transport detection (HTTP+SSE)
                  const hasDeprecatedTransport = infoEntries.some(
                    ({ log }) =>
                      log.label?.includes("HTTP+SSE Transport Detected") ||
                      log.id === "http-sse-detected",
                  );

                  const errorInfoCount = infoEntries.filter(
                    ({ log }) => log.level === "error",
                  ).length;
                  const httpErrorCount = httpEntries.filter(({ entry }) => {
                    if (entry.error) return true;
                    const status = entry.response?.status;
                    // Don't treat 401 on initial request as error
                    if (
                      entry.step === "request_without_token" &&
                      status === 401
                    ) {
                      return false;
                    }
                    // Don't treat 4xx on authenticated_mcp_request as error if deprecated transport was detected
                    // (the 4xx triggers the GET fallback for backwards compatibility)
                    if (
                      entry.step === "authenticated_mcp_request" &&
                      hasDeprecatedTransport &&
                      status &&
                      status >= 400 &&
                      status < 500
                    ) {
                      return false;
                    }
                    return typeof status === "number" && status >= 400;
                  }).length;
                  const errorCount = errorInfoCount + httpErrorCount;
                  const hasError = errorCount > 0;
                  const firstErrorMessage =
                    infoEntries.find(({ log }) => log.level === "error")?.log
                      .error?.message ||
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
                            : hasDeprecatedTransport
                              ? "border-yellow-400 ring-1 ring-yellow-400/20 shadow-md"
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
                            ) : hasDeprecatedTransport ? (
                              <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
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
                              {hasDeprecatedTransport && !hasError && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] h-4 px-1.5 border-yellow-400 text-yellow-700 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-950/30"
                                >
                                  HTTP+SSE transport
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
        </TabsContent>

        <TabsContent value="raw" className="flex-1 overflow-hidden">
          <div ref={rawScrollRef} className="h-full bg-muted/30 overflow-auto">
            <div className="p-6 space-y-3">
              {timelineEntries.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No activity yet.
                </div>
              ) : (
                timelineEntries.map((entry) => {
                  if (entry.type === "info") {
                    const { log } = entry;
                    const level = log.level ?? "info";
                    const levelBadgeVariant =
                      level === "error"
                        ? "destructive"
                        : level === "warning"
                          ? "outline"
                          : "secondary";

                    return (
                      <div key={entry.key} className="space-y-1">
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="font-mono">{log.step}</span>
                          <span>{formatTimestamp(log.timestamp)}</span>
                          <Badge
                            variant={levelBadgeVariant}
                            className="uppercase tracking-tight"
                          >
                            {level}
                          </Badge>
                        </div>
                        <InfoLogEntry
                          label={log.label}
                          timestamp={log.timestamp}
                          data={log.data}
                          level={level}
                          error={log.error}
                        />
                      </div>
                    );
                  }

                  const httpEntry: HttpHistoryEntry = entry.entry;
                  const status = httpEntry.response?.status;
                  const isExpectedAuthChallenge =
                    httpEntry.step === "request_without_token" &&
                    status === 401;
                  const isHttpError =
                    Boolean(httpEntry.error) ||
                    (typeof status === "number" &&
                      status >= 400 &&
                      !isExpectedAuthChallenge);
                  const statusLabel =
                    status !== undefined
                      ? `${status}${httpEntry.response?.statusText ? ` ${httpEntry.response?.statusText}` : ""}`
                      : "pending";

                  return (
                    <div key={entry.key} className="space-y-1">
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="font-mono">{httpEntry.step}</span>
                        <span>{formatTimestamp(httpEntry.timestamp)}</span>
                        <Badge
                          variant="outline"
                          className="font-mono uppercase"
                        >
                          {httpEntry.request.method}
                        </Badge>
                        <Badge
                          variant={isHttpError ? "destructive" : "secondary"}
                          className="font-mono"
                        >
                          {statusLabel}
                        </Badge>
                      </div>
                      <HTTPHistoryEntry
                        method={httpEntry.request.method}
                        url={httpEntry.request.url}
                        status={httpEntry.response?.status}
                        statusText={httpEntry.response?.statusText}
                        duration={httpEntry.duration}
                        requestHeaders={httpEntry.request.headers}
                        requestBody={httpEntry.request.body}
                        responseHeaders={httpEntry.response?.headers}
                        responseBody={httpEntry.response?.body}
                        error={httpEntry.error}
                        step={httpEntry.step}
                      />
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
