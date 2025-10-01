import { useCallback, useMemo, useState, useEffect } from "react";
import Denque from "denque";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export type LogContext = "Connections" | "ToolsTab";
export interface LogEntry {
  server: string;
  timestamp: string;
  level: LogLevel;
  context: string;
  message: string;
  data?: unknown;
  error?: Error;
}

export interface LoggerConfig {
  level: LogLevel;
  enableConsole: boolean;
  maxBufferSize: number;
}

export const LOG_CONTEXTS: LogContext[] = ["Connections", "ToolsTab"];

export const LOG_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const LOG_COLORS: Record<LogLevel, string> = {
  error: "#ef4444",
  warn: "#f59e0b",
  info: "#3b82f6",
  debug: "#8b5cf6",
  trace: "#6b7280",
};

// Global logger state
class LoggerState {
  private config: LoggerConfig = {
    level: "info",
    enableConsole: true,
    maxBufferSize: 1000,
  };

  private buffer = new Denque<LogEntry>([], {
    capacity: this.config.maxBufferSize,
  });

  private listeners: Set<() => void> = new Set();

  setConfig(config: Partial<LoggerConfig>) {
    this.config = { ...this.config, ...config };
    this.notifyListeners();
  }

  getConfig(): LoggerConfig {
    return { ...this.config };
  }

  addEntry(entry: LogEntry) {
    this.buffer.unshift(entry);
    this.notifyListeners();
  }

  getEntries(): LogEntry[] {
    return this.buffer.toArray();
  }

  clearBuffer() {
    this.buffer.clear();
    this.notifyListeners();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners() {
    this.listeners.forEach((listener) => listener());
  }

  shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] <= LOG_LEVELS[this.config.level];
  }
}

const loggerState = new LoggerState();

// Set initial config based on environment
if (typeof window !== "undefined") {
  const isDevelopment = process.env.NODE_ENV === "development";
  loggerState.setConfig({
    level: isDevelopment ? "debug" : "info",
    enableConsole: true,
  });
}

interface LogData {
  serverId?: string;
  [key: string]: unknown;
}
export interface Logger {
  error: (message: string, data?: LogData, error?: Error) => void;
  warn: (message: string, data?: LogData) => void;
  info: (message: string, data?: LogData) => void;
  debug: (message: string, data?: LogData) => void;
  trace: (message: string, data?: LogData) => void;
  context: LogContext;
}

export function useLogger(context: LogContext): Logger {
  const createLogFunction = useCallback(
    (level: LogLevel) => (message: string, data?: LogData, error?: Error) => {
      if (!loggerState.shouldLog(level)) {
        return;
      }

      const timestamp = new Date().toISOString();

      const server = data?.serverId ?? "Unknown";

      const entry: LogEntry = {
        server,
        timestamp,
        level,
        context,
        message,
        data,
        error,
      };

      loggerState.addEntry(entry);

      // Console output if enabled
      const config = loggerState.getConfig();
      if (config.enableConsole) {
        outputToConsole(entry);
      }
    },
    [context]
  );

  const logger = useMemo(
    () => ({
      error: createLogFunction("error"),
      warn: createLogFunction("warn"),
      info: createLogFunction("info"),
      debug: createLogFunction("debug"),
      trace: createLogFunction("trace"),
      context,
    }),
    [createLogFunction, context]
  );

  return logger;
}

function outputToConsole(entry: LogEntry) {
  const { timestamp, level, context, message, data, error } = entry;
  const time = new Date(timestamp).toLocaleTimeString();
  const color = LOG_COLORS[level];

  const contextStyle = `color: ${color}; font-weight: bold;`;
  const messageStyle = `color: ${color};`;

  const args: unknown[] = [
    `%c[${time}] %c${level.toUpperCase()} %c[${context}] %c${message}`,
    "color: #6b7280;",
    contextStyle,
    "color: #6b7280;",
    messageStyle,
  ];

  if (data !== undefined) {
    args.push("\nData:", data);
  }

  if (error) {
    args.push("\nError:", error);
  }

  const consoleMethod =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "debug"
          ? console.debug
          : console.log;

  consoleMethod(...args);
}

// Global logger utilities
export const LoggerUtils = {
  setLevel: (level: LogLevel) => {
    loggerState.setConfig({ level });
  },

  getLevel: (): LogLevel => {
    return loggerState.getConfig().level;
  },

  setConsoleEnabled: (enabled: boolean) => {
    loggerState.setConfig({ enableConsole: enabled });
  },

  isConsoleEnabled: (): boolean => {
    return loggerState.getConfig().enableConsole;
  },

  getAllEntries: (): LogEntry[] => {
    return loggerState.getEntries();
  },

  clearLogs: () => {
    loggerState.clearBuffer();
  },

  subscribeToLogs: (callback: () => void) => {
    return loggerState.subscribe(callback);
  },

  getConfig: () => {
    return loggerState.getConfig();
  },

  setConfig: (config: Partial<LoggerConfig>) => {
    loggerState.setConfig(config);
  },
};

// Hook for components that need to observe log changes
export function useLoggerState() {
  const [entries, setEntries] = useState(loggerState.getEntries());
  const [config, setConfigState] = useState(loggerState.getConfig());

  const [, forceUpdate] = useState({});

  useEffect(() => {
    const unsubscribe = loggerState.subscribe(() => {
      setEntries(loggerState.getEntries());
      setConfigState(loggerState.getConfig());
      forceUpdate({});
    });
    return () => {
      unsubscribe();
    };
  }, []);

  return {
    entries: useMemo(() => entries, [entries]),
    config: useMemo(() => config, [config]),
    setConfig: loggerState.setConfig.bind(loggerState),
    clearBuffer: loggerState.clearBuffer.bind(loggerState),
  };
}
