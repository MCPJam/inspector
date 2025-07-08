import { ClientLogInfo } from "@/hooks/helpers/types";
import { AlertCircle, Info, AlertTriangle, Bug } from "lucide-react";
import CopyIcon from "./CopyIcon";

interface ClientLogsTabProps {
  clientLogs: ClientLogInfo[];
  showHeader?: boolean;
}

const ClientLogsTab = ({
  clientLogs,
  showHeader = true,
}: ClientLogsTabProps) => {
  const reversedClientLogs = [...clientLogs].reverse();
  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("en-US", {
      hour12: true,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const getLogLevelConfig = (level: ClientLogInfo["level"]) => {
    switch (level) {
      case "error":
        return {
          icon: AlertCircle,
          bgColor: "bg-red-50 dark:bg-red-950/20",
          borderColor: "border-red-200 dark:border-red-800/50",
          textColor: "text-red-800 dark:text-red-300",
          iconColor: "text-red-500",
          label: "ERROR",
        };
      case "warn":
        return {
          icon: AlertTriangle,
          bgColor: "bg-yellow-50 dark:bg-yellow-950/20",
          borderColor: "border-yellow-200 dark:border-yellow-800/50",
          textColor: "text-yellow-800 dark:text-yellow-300",
          iconColor: "text-yellow-500",
          label: "WARN",
        };
      case "debug":
        return {
          icon: Bug,
          bgColor: "bg-gray-50 dark:bg-gray-950/20",
          borderColor: "border-gray-200 dark:border-gray-800/50",
          textColor: "text-gray-800 dark:text-gray-300",
          iconColor: "text-gray-500",
          label: "DEBUG",
        };
      case "info":
      default:
        return {
          icon: Info,
          bgColor: "bg-blue-50 dark:bg-blue-950/20",
          borderColor: "border-blue-200 dark:border-blue-800/50",
          textColor: "text-blue-800 dark:text-blue-300",
          iconColor: "text-blue-500",
          label: "INFO",
        };
    }
  };

  const LogEntry = ({ log }: { log: ClientLogInfo }) => {
    const config = getLogLevelConfig(log.level);
    const IconComponent = config.icon;

    return (
      <div
        className={`group flex items-start space-x-3 p-3 rounded-lg border ${config.bgColor} ${config.borderColor} hover:shadow-sm transition-all duration-200`}
      >
        <div className={`flex-shrink-0 mt-0.5 ${config.iconColor}`}>
          <IconComponent className="w-4 h-4" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center mb-1 space-x-2">
        <span
          className={`text-xs font-mono font-semibold px-2 py-0.5 rounded ${config.textColor} ${config.bgColor}`}
        >
          {config.label}
        </span>
            <span className="font-mono text-xs text-muted-foreground">
          {formatTimestamp(log.timestamp)}
        </span>
          </div>

          <div className={`text-sm ${config.textColor} font-mono break-words`}>
            {log.message}
          </div>
        </div>

        <div className="flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <CopyIcon value={log.message} />
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {!showHeader && clientLogs.length > 0 && (
        <div className="flex items-center justify-between mb-6">
          <span className="px-3 py-1 text-sm rounded-full text-muted-foreground bg-muted/50">
            {clientLogs.length} log
            {clientLogs.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        {clientLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center">
            <Bug className="w-12 h-12 mb-4 text-muted-foreground/50" />
            <h3 className="mb-2 text-lg font-medium text-muted-foreground">
              No logs yet
            </h3>
            <p className="max-w-sm text-sm text-muted-foreground/70">
              Client logs will appear here when you perform operations. Logs
              include info, warnings, errors, and debug messages.
            </p>
          </div>
        ) : (
          <div className="h-full p-4 space-y-2 overflow-y-auto">
            {reversedClientLogs.map((log, index) => (
              <LogEntry key={`${log.timestamp}-${index}`} log={log} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ClientLogsTab;
