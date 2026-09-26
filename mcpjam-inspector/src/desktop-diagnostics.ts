import { randomUUID } from "node:crypto";
import {
  parseDesktopActivity,
  type DesktopActivity,
} from "../shared/desktop-diagnostics.js";

type RecordEntry = DesktopActivity & { at: number };
type ExitDetails = {
  type: string;
  serviceName?: string;
  reason: string;
  exitCode: number;
};
const PROXY_SERVICE = "proxy_resolver.mojom.ProxyResolverFactory";
const WINDOW_MS = 60_000;

/** No SDK dependency: the same state machine is exercised by tests and Electron. */
export function createDesktopDiagnostics(options: {
  publish: (snapshot: Record<string, unknown>) => void;
  report: (summary: Record<string, unknown>) => void;
  now?: () => number;
  runId?: string;
}) {
  const now = options.now ?? Date.now;
  const runId = options.runId ?? randomUUID();
  let history: RecordEntry[] = [];
  let rendererAt: number | undefined;
  let auth: DesktopActivity["auth"];
  let version: string | undefined;
  let reports = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending:
    | {
        incident_id: string;
        observation_event_id: string;
        started_at: number;
        exits: number;
        reason: string;
        exit_code: number;
        native_event_ids: string[];
        before: RecordEntry[];
        after: RecordEntry[];
        successes: number;
        failures: number;
        renderer_exits: number;
      }
    | undefined;
  const safe = (action: () => void) => {
    try {
      action();
    } catch {
      /* Diagnostics never affect app behavior. */
    }
  };
  function snapshot() {
    history = history.filter((x) => now() - x.at <= 120_000).slice(-50);
    return {
      // Only this bounded, allowlisted context needs deeper normalization.
      __sentry_override_normalization_depth__: 5,
      run_id: runId,
      renderer_version: version ?? "unknown",
      auth: auth ?? "unknown",
      renderer_last_seen_at: rendererAt ?? null,
      renderer_context_stale:
        rendererAt === undefined || now() - rendererAt > 30_000,
      incident_id: pending?.incident_id ?? null,
      observation_event_id: pending?.observation_event_id ?? null,
      activity: [...history],
    };
  }
  function publish() {
    safe(() => options.publish(snapshot()));
  }
  function record(value: unknown) {
    const activity = parseDesktopActivity(value);
    if (!activity) return;
    rendererAt = now();
    if (activity.auth) auth = activity.auth;
    if (activity.version) version = activity.version;
    const entry = { ...activity, at: now() };
    history.push(entry);
    if (pending) {
      pending.after = [...pending.after, entry].slice(-50);
      if (activity.kind === "connect" || activity.kind === "reconnect") {
        if (activity.phase === "success") pending.successes++;
        if (activity.phase === "failure") pending.failures++;
      }
    }
    publish();
  }
  function finish(interrupted = false) {
    if (!pending) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const incident = pending;
    pending = undefined;
    reports++;
    safe(() =>
      options.report({
        ...snapshot(),
        ...incident,
        elapsed_ms: now() - incident.started_at,
        observation: interrupted ? "interrupted" : "complete",
        outcome:
          incident.successes > 0
            ? "connection_succeeded_afterward"
            : incident.failures > 0
              ? "connections_failed_afterward"
              : "no_connection_observed",
      }),
    );
    publish();
  }
  function childExit(details: ExitDetails) {
    if (
      details.type !== "Utility" ||
      details.serviceName !== PROXY_SERVICE ||
      details.reason === "clean-exit"
    )
      return;
    if (pending) {
      pending.exits++;
      return;
    }
    if (reports >= 5) return;
    pending = {
      incident_id: randomUUID(),
      observation_event_id: randomUUID().replaceAll("-", ""),
      started_at: now(),
      exits: 1,
      reason: [
        "killed",
        "crashed",
        "oom",
        "abnormal-exit",
        "launch-failed",
        "integrity-failure",
      ].includes(details.reason)
        ? details.reason
        : "other",
      exit_code: details.exitCode,
      native_event_ids: [],
      before: snapshot().activity,
      after: [],
      successes: 0,
      failures: 0,
      renderer_exits: 0,
    };
    publish();
    timer = setTimeout(() => finish(), WINDOW_MS);
    timer.unref?.();
  }
  function nativeEvent(event: {
    event_id?: string;
    platform?: string;
    tags?: Record<string, unknown>;
    contexts?: Record<string, any>;
  }) {
    // Never relabel a minidump restored from another run or another utility.
    const details = event.contexts?.electron?.details;
    if (
      event.platform === "native" &&
      event.contexts?.desktop_diagnostics?.run_id === runId
    ) {
      // Startup minidumps have no live child details. Old installations had
      // no diagnostic scope, so Sentry may merge this run's scope into them.
      // Missing provenance is unknown, never evidence of this run's activity.
      if (!details) {
        delete event.contexts.desktop_diagnostics;
        if (event.tags) delete event.tags.desktop_run_id;
        return;
      }
      event.contexts.desktop_diagnostics = snapshot();
    }
    if (
      pending &&
      event.platform === "native" &&
      event.contexts?.desktop_diagnostics?.run_id === runId &&
      details?.serviceName === PROXY_SERVICE &&
      event.event_id &&
      !pending.native_event_ids.includes(event.event_id)
    ) {
      pending.native_event_ids = [
        ...pending.native_event_ids,
        event.event_id,
      ].slice(-10);
    }
  }
  function rendererGone(exited = false) {
    record({ kind: "renderer", phase: exited ? "failure" : "start" });
    if (pending && exited) pending.renderer_exits++;
    rendererAt = undefined;
    auth = undefined;
    publish();
  }
  publish();
  return {
    record,
    childExit,
    nativeEvent,
    rendererGone,
    snapshot,
    finish,
    runId,
  };
}
