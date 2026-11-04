import {
  DEFAULT_CONFORMANCE_RUN_TIMEOUT_SECONDS,
  MAX_CONFORMANCE_RUN_TIMEOUT_SECONDS,
} from "@/shared/conformance-timeout";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConformanceRunBudget } from "@/lib/apis/mcp-conformance-api";

/** Owns one deadline across the concurrent suites and interactive OAuth wait. */
export function useConformanceDeadline(onExpire: (message: string) => void) {
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  const current = useRef<{
    seconds: number;
    endsAt: number;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [runTimeoutSeconds, setRunTimeoutSeconds] = useState<number>();
  const clear = useCallback(() => {
    const run = current.current;
    current.current = null;
    if (run) {
      clearTimeout(run.timer);
      run.controller.abort();
    }
  }, []);
  const start = useCallback(
    (seconds = DEFAULT_CONFORMANCE_RUN_TIMEOUT_SECONDS) => {
      clear();
      if (
        !Number.isInteger(seconds) ||
        seconds < 1 ||
        seconds > MAX_CONFORMANCE_RUN_TIMEOUT_SECONDS
      ) {
        throw new Error(
          "Run timeout must be a whole number from 1 to 300 seconds.",
        );
      }
      setRunTimeoutSeconds(seconds);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        const message = `Run timed out after ${seconds} seconds`;
        expireRef.current(message);
        controller.abort(new Error(message));
        current.current = null;
      }, seconds * 1_000);
      current.current = {
        seconds,
        endsAt: Date.now() + seconds * 1_000,
        controller,
        timer,
      };
    },
    [clear],
  );
  const isExpired = useCallback(() => {
    const run = current.current;
    if (!run || Date.now() < run.endsAt) return false;
    clearTimeout(run.timer);
    current.current = null;
    const message = `Run timed out after ${run.seconds} seconds`;
    expireRef.current(message);
    run.controller.abort(new Error(message));
    return true;
  }, []);
  const budget = useCallback((): ConformanceRunBudget => {
    const run = current.current;
    if (!run) return {};
    isExpired();
    run.controller.signal.throwIfAborted();
    return {
      runTimeoutSeconds: run.seconds,
      remainingRunTimeoutMs: Math.max(1, run.endsAt - Date.now()),
      signal: run.controller.signal,
    };
  }, [isExpired]);
  useEffect(() => clear, [clear]);
  return { start, clear, budget, isExpired, runTimeoutSeconds };
}
