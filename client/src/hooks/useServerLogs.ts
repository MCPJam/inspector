import { useState, useEffect } from "react";
import { ClientLogInfo } from "./helpers/types";

export function useServerLogs(logFile: string) {
  const [logs, setLogs] = useState<ClientLogInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    const fetchLogs = () => {
      fetch(`/logs/${encodeURIComponent(logFile)}`)
        .then((res) => {
          const contentType = res.headers.get('content-type') || '';
          if (!contentType.includes('text/plain')) {
            return '';
          }
          return res.text();
        })
        .then((text) => {
          if (!text || text.startsWith('<!DOCTYPE html') || text.startsWith('<html')) {
            setLogs([]);
            setLoading(false);
            return;
          }
          const logLineRegex = /^(\d{4}-\d{2}-\d{2}T[^\s]+) \[([^\]]+)\] \[([^\]]+)\] (.*) \{ metadata: (.*) \}$/;
          const parsed: ClientLogInfo[] = text
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const match = logLineRegex.exec(line);
              if (match) {
                const [, timestamp, subsystem, level, message] = match;
                return { message, level: level as any, timestamp };
              }
              // fallback: try JSON, or just plain
              try {
                const obj = JSON.parse(line);
                if (obj && obj.message && obj.level && obj.timestamp) {
                  return obj as ClientLogInfo;
                }
                return {
                  message: line,
                  level: "info",
                  timestamp: new Date().toISOString(),
                };
              } catch {
                return {
                  message: line,
                  level: "info",
                  timestamp: new Date().toISOString(),
                };
              }
            });
          setLogs(parsed);
          setLoading(false);
        })
        .catch(() => {
          setLogs([]);
          setLoading(false);
        });
    };
    fetchLogs();
    interval = setInterval(fetchLogs, 3000); // Poll every 3 seconds
    return () => clearInterval(interval);
  }, [logFile]);

  return { logs, loading };
} 