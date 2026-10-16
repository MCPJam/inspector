import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { RecorderCaptureMode } from "@mcpjam/sdk/widget-runtime";
import type { SandboxedIframeHandle } from "./sandboxed-iframe";

type ReplayResult = { ok: boolean; reason?: string; deferred?: string };
type Flush = () => Promise<ReplayResult>;
type Replay = (step: unknown) => Promise<ReplayResult>;
type RecorderOptions = {
  sandbox: RefObject<SandboxedIframeHandle | null>;
  capable?: boolean;
  mode?: RecorderCaptureMode;
  onStep?: (step: unknown, captureId?: string) => void;
  onPick?: (target: unknown) => void;
  onReady?: () => void;
  onFlushReady?: (flush: Flush | null) => void;
  onReplayReady?: (replay: Replay | null) => void;
};

function useReplayController(
  options: RecorderOptions,
  latest: { current: RecorderOptions },
) {
  const nextId = useRef(0);
  const pending = useRef(
    new Map<
      number,
      {
        resolve: (result: ReplayResult) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const request = useCallback(
    (
      type: "recorder:replay-step" | "recorder:flush",
      step?: unknown,
    ): Promise<ReplayResult> =>
      new Promise((resolve) => {
        const id = ++nextId.current;
        const timer = setTimeout(() => {
          pending.current.delete(id);
          resolve({ ok: false, reason: "recorder request timed out" });
        }, 8000);
        pending.current.set(id, { resolve, timer });
        latest.current.sandbox.current?.postMessage({
          type,
          id,
          step,
        });
      }),
    [],
  );
  const replay = useCallback<Replay>(
    (step) => request("recorder:replay-step", step),
    [request],
  );
  const flush = useCallback<Flush>(() => request("recorder:flush"), [request]);
  useEffect(() => {
    latest.current.onReplayReady?.(options.capable ? replay : null);
    return () => {
      latest.current.onReplayReady?.(null);
      latest.current.onFlushReady?.(null);
      for (const { resolve, timer } of pending.current.values()) {
        clearTimeout(timer);
        resolve({ ok: false, reason: "widget unmounted" });
      }
      pending.current.clear();
    };
  }, [options.capable, replay]);
  return { pending, flush };
}

export function useWidgetRecorder(options: RecorderOptions) {
  const latest = useRef(options);
  latest.current = options;
  const { pending, flush } = useReplayController(options, latest);
  const configure = useCallback(() => {
    const current = latest.current;
    current.sandbox.current?.postMessage({
      type: "recorder:configure",
      mode: current.capable ? (current.mode ?? "record") : "off",
    });
  }, []);
  useEffect(configure, [configure, options.capable, options.mode]);
  const handleRecorderMessage = useCallback(
    (data: unknown): boolean => {
      if (!data || typeof data !== "object" || !("type" in data)) return false;
      const current = latest.current;
      if (data.type === "recorder:ready") {
        configure();
        current.onReady?.();
        current.onFlushReady?.(current.capable ? flush : null);
      } else if (data.type === "recorder:step") {
        if (
          current.capable &&
          current.mode !== "off" &&
          current.mode !== "pick" &&
          "step" in data
        )
          current.onStep?.(
            data.step,
            "captureId" in data && typeof data.captureId === "string"
              ? data.captureId
              : undefined,
          );
      } else if (data.type === "recorder:pick") {
        if (current.capable && current.mode === "pick" && "target" in data)
          current.onPick?.(data.target);
      } else if (
        data.type === "recorder:replay-result" ||
        data.type === "recorder:flushed"
      ) {
        const id = "id" in data && typeof data.id === "number" ? data.id : -1;
        const request = pending.current.get(id);
        if (request) {
          clearTimeout(request.timer);
          pending.current.delete(id);
          request.resolve({
            ok: "ok" in data && data.ok === true,
            ...("reason" in data && typeof data.reason === "string"
              ? { reason: data.reason }
              : {}),
            ...("deferred" in data && typeof data.deferred === "string"
              ? { deferred: data.deferred }
              : {}),
          });
        }
      } else return false;
      return true;
    },
    [configure],
  );
  return { handleRecorderMessage };
}
