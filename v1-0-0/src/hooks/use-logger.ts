import { useCallback, useMemo, useState, useEffect } from "react";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface LogEntry {
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

const LOG_LEVELS: Record<LogLevel, number> = {
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

  private buffer: LogEntry[] = [];
  private listeners: Set<() => void> = new Set();

  setConfig(config: Partial<LoggerConfig>) {
    this.config = { ...this.config, ...config };
    this.notifyListeners();
  }

  getConfig(): LoggerConfig {
    return { ...this.config };
  }

  addEntry(entry: LogEntry) {
    this.buffer.push(entry);

    // Maintain buffer size limit
    if (this.buffer.length > this.config.maxBufferSize) {
      this.buffer = this.buffer.slice(-this.config.maxBufferSize);
    }

    this.notifyListeners();
  }

  getEntries(): LogEntry[] {
    return [...this.buffer];
  }

  getFilteredEntries(level?: LogLevel, context?: string): LogEntry[] {
    let entries = this.buffer;

    if (level) {
      const levelThreshold = LOG_LEVELS[level];
      entries = entries.filter(
        (entry) => LOG_LEVELS[entry.level] <= levelThreshold,
      );
    }

    if (context) {
      const contextLower = context.toLowerCase();
      entries = entries.filter((entry) =>
        entry.context.toLowerCase().includes(contextLower),
      );
    }

    return entries;
  }

  clearBuffer() {
    this.buffer = [];
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

export interface Logger {
  error: (message: string, data?: unknown, error?: Error) => void;
  warn: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  debug: (message: string, data?: unknown) => void;
  trace: (message: string, data?: unknown) => void;
  context: string;
}

export function useLogger(context: string = "Unknown"): Logger {
  const createLogFunction = useCallback(
    (level: LogLevel) => (message: string, data?: unknown, error?: Error) => {
      if (!loggerState.shouldLog(level)) {
        return;
      }

      const timestamp = new Date().toISOString();
      const entry: LogEntry = {
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
    [context],
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
    [createLogFunction, context],
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

  getFilteredEntries: (level?: LogLevel, context?: string): LogEntry[] => {
    return loggerState.getFilteredEntries(level, context);
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
  const [, forceUpdate] = useState({});

  useEffect(() => {
    const unsubscribe = loggerState.subscribe(() => {
      forceUpdate({});
    });
    return () => {
      unsubscribe();
    };
  }, []);

  return {
    entries: loggerState.getEntries(),
    config: loggerState.getConfig(),
    setConfig: loggerState.setConfig.bind(loggerState),
    clearBuffer: loggerState.clearBuffer.bind(loggerState),
    getFilteredEntries: loggerState.getFilteredEntries.bind(loggerState),
  };
}
