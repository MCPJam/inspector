import { useEffect, useState } from "react";
import type { ModelDefinition } from "@/shared/types";
import {
  detectOllamaModels,
  detectOllamaToolCapableModels,
} from "@/lib/ollama-utils";
import { HOSTED_MODE } from "@/lib/config";

const OLLAMA_POLL_INTERVAL_MS = 30_000;
const OLLAMA_POLL_MAX_INTERVAL_MS = 10 * 60_000;

/**
 * Polls the local Ollama daemon and surfaces its models as picker entries,
 * marking tool-incapable models disabled. Local mode only: in hosted mode
 * the browser may reach localhost, but the hosted (Convex) chat path can't,
 * so the hook reports nothing rather than offering models chat can't run.
 *
 * Not having Ollama installed is the common case, and every probe of a closed
 * port logs a connection error at the browser level that no JS catch can
 * swallow. Two things keep that noise down:
 *
 *  - Backoff: 30s -> 1m -> 2m -> 4m -> 8m, then pinned at the 10m cap,
 *    while the daemon stays unreachable; back to the base interval on the
 *    first success.
 *  - Visibility: polling pauses while the tab is hidden and resumes with
 *    whatever is *left* of the current delay — coming back to the tab is
 *    not itself a reason to probe, or flipping tabs would become its own
 *    burst of requests. This tracks the tab being hidden/shown only, not
 *    focus or clicks inside the app.
 */
export function useDetectedOllamaModels(getOllamaBaseUrl: () => string): {
  isOllamaRunning: boolean;
  ollamaModels: ModelDefinition[];
} {
  const [ollamaModels, setOllamaModels] = useState<ModelDefinition[]>([]);
  const [isOllamaRunning, setIsOllamaRunning] = useState(false);

  useEffect(() => {
    if (HOSTED_MODE) {
      setIsOllamaRunning(false);
      setOllamaModels([]);
      return;
    }

    let cancelled = false;
    let timeoutId: number | undefined;
    let inFlight = false;
    let consecutiveFailures = 0;
    let nextDueAt = Date.now();

    const nextDelayMs = () =>
      consecutiveFailures === 0
        ? OLLAMA_POLL_INTERVAL_MS
        : Math.min(
            OLLAMA_POLL_INTERVAL_MS * 2 ** (consecutiveFailures - 1),
            OLLAMA_POLL_MAX_INTERVAL_MS
          );

    // Arm a timer for whatever is left until nextDueAt. Does nothing while the
    // tab is hidden, and never stacks a second timer onto a live one. It also
    // stands down while a probe is in flight: that probe's `finally` owns the
    // next slot, and arming against the *current* (already past) nextDueAt
    // would fire a 0ms timer that jumps the queue the moment it resolves.
    const arm = () => {
      if (cancelled || document.hidden || inFlight || timeoutId !== undefined) {
        return;
      }
      timeoutId = window.setTimeout(() => {
        timeoutId = undefined;
        void checkOllama();
      }, Math.max(0, nextDueAt - Date.now()));
    };

    const disarm = () => {
      if (timeoutId === undefined) return;
      window.clearTimeout(timeoutId);
      timeoutId = undefined;
    };

    const checkOllama = async () => {
      if (inFlight) return;
      inFlight = true;
      let daemonAnswered = false;
      try {
        const { isRunning, availableModels } = await detectOllamaModels(
          getOllamaBaseUrl()
        );
        if (cancelled) return;
        daemonAnswered = isRunning;
        setIsOllamaRunning(isRunning);

        consecutiveFailures = isRunning ? 0 : consecutiveFailures + 1;

        const toolCapable = isRunning
          ? await detectOllamaToolCapableModels(getOllamaBaseUrl())
          : [];
        if (cancelled) return;
        const toolCapableSet = new Set(toolCapable);
        setOllamaModels(
          availableModels.map((modelName) => ({
            id: modelName,
            name: modelName,
            provider: "ollama" as const,
            disabled: !toolCapableSet.has(modelName),
            disabledReason: toolCapableSet.has(modelName)
              ? undefined
              : "Model does not support tool calling",
          }))
        );
      } catch (error) {
        if (!cancelled) {
          console.error("Ollama detection probe threw", error);
          setIsOllamaRunning(daemonAnswered);
          setOllamaModels([]);
          consecutiveFailures += 1;
        }
      } finally {
        inFlight = false;
        if (!cancelled) {
          nextDueAt = Date.now() + nextDelayMs();
          arm();
        }
      }
    };

    const handleVisibilityChange = () => {
      if (cancelled) return;
      if (document.hidden) {
        disarm();
      } else {
        arm();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    if (!document.hidden) {
      void checkOllama();
    }

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      disarm();
    };
  }, [getOllamaBaseUrl]);

  return { isOllamaRunning, ollamaModels };
}
