import { CompatibilityCallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useEffect, useState, useCallback } from "react";
import { ChevronDown, GripHorizontal } from "lucide-react";
import { useDraggablePane } from "../lib/hooks/useDraggablePane";
import TabbedHistoryPanel from "./TabbedHistoryPanel";
import { ClientLogInfo, RequestHistoryInfo } from "@/hooks/helpers/types";

export type TabType = "activity" | "results" | "logs";

const TAB_CONFIG: { key: TabType; label: string }[] = [
  { key: "activity", label: "History" },
  { key: "results", label: "Results" },
  { key: "logs", label: "Logs" },
];

const HistoryAndNotifications = ({
  requestHistory,
  toolResult,
  clientLogs,
  onClearHistory,
  onClearLogs,
}: {
  requestHistory: RequestHistoryInfo[];
  toolResult: CompatibilityCallToolResult | null;
  clientLogs: ClientLogInfo[];
  onClearHistory: () => void;
  onClearLogs: () => void;
}) => {
  const [isCollapsed, setIsCollapsed] = useState(true);
  // allow null so no tab is selected initially
  const [activeTab, setActiveTab] = useState<TabType | null>(null);
  const { height, isDragging, handleDragStart, resetHeight, setCustomHeight } =
    useDraggablePane(500, "historyPaneHeight");

  // Toggle collapse/expand and clear selection on collapse
  const toggleCollapse = useCallback(() => {
    setIsCollapsed((c) => {
      const next = !c;
      if (next) {
        // about to collapse: clear tab selection
        setActiveTab(null);
      }
      return next;
    });
  }, []);

  // Double‑click to reset height
  const handleDoubleClick = useCallback(() => {
    if (!isCollapsed) resetHeight();
  }, [isCollapsed, resetHeight]);

  // Keyboard shortcuts for resizing when expanded
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isCollapsed) return;
      const tag = (e.target as HTMLElement)?.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea") return;

      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const inc = e.shiftKey ? 50 : 25;
        const newH = e.key === "ArrowUp" ? height + inc : height - inc;
        setCustomHeight(newH);
      }
      if (e.altKey && e.key === "r") {
        e.preventDefault();
        resetHeight();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isCollapsed, height, setCustomHeight, resetHeight]);

  // Auto‑expand on new result or error log, and select appropriate tab
  useEffect(() => {
    if (toolResult) {
      setActiveTab("results");
      setIsCollapsed(false);
    }
  }, [toolResult]);

  useEffect(() => {
    if (
      clientLogs.length &&
      clientLogs[clientLogs.length - 1].level === "error"
    ) {
      setActiveTab("logs");
      setIsCollapsed(false);
    }
  }, [clientLogs]);

  useEffect(() => {
    const lastRequest = requestHistory[requestHistory.length - 1].request;
    const lastRequestMethod = JSON.parse(lastRequest).method;
    if (lastRequestMethod && lastRequestMethod === "ping") {
      setIsCollapsed(false);
    }
  }, [requestHistory]);

  // Counts for display
  const counts = {
    activity: requestHistory.length,
    results: toolResult ? 1 : 0,
    logs: clientLogs.length,
  };

  return (
    <div
      className={`relative bg-card backdrop-blur-md border-t border-border/30 transition-shadow duration-300 ${
        isCollapsed ? "shadow-md" : "shadow-xl"
      }`}
      style={{ height: isCollapsed ? 40 : height }}
    >
      {/* Drag Handle */}
      <div
        className={`absolute w-full h-3 -top-1.5 cursor-row-resize flex items-center justify-center ${
          isDragging ? "bg-primary/20" : "hover:bg-border/20"
        } transition-all duration-200`}
        onMouseDown={handleDragStart}
        onDoubleClick={handleDoubleClick}
        title="Drag to resize • Double‑click to reset • Alt+↑↓ to adjust • Alt+R to reset"
      >
        <GripHorizontal
          className={`w-4 h-4 text-muted-foreground transition-opacity duration-200 ${
            isDragging ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        />
      </div>

      {/* Content */}
      {isCollapsed ? (
        // Collapsed: tab bar
        <div className="h-full flex items-center">
          {TAB_CONFIG.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => {
                setActiveTab(key);
                setIsCollapsed(false);
              }}
              className={`flex items-center h-full px-4 text-sm font-medium transition-colors duration-200 ${
                activeTab === key
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
              {counts[key] > 0 && (
                <span className="ml-1 px-1 rounded bg-muted/30 text-xs">
                  {counts[key]}
                </span>
              )}
            </button>
          ))}

          <div className="ml-auto pr-3 cursor-pointer" onClick={toggleCollapse}>
            <ChevronDown
              className={`w-5 h-5 transform transition-transform duration-200 ${
                isCollapsed ? "rotate-180" : "rotate-0"
              }`}
            />
          </div>
        </div>
      ) : (
        // Expanded: full panel
        <TabbedHistoryPanel
          requestHistory={requestHistory}
          toolResult={toolResult}
          clientLogs={clientLogs}
          onClearHistory={onClearHistory}
          onClearLogs={onClearLogs}
          onToggleCollapse={toggleCollapse}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
        />
      )}
    </div>
  );
};

export default HistoryAndNotifications;
