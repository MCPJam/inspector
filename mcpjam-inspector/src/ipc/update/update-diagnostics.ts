import fs from "node:fs";
import path from "node:path";
import log from "electron-log";

export type UpdateTrigger =
  | "startup"
  | "scheduled"
  | "automatic_retry"
  | "user_retry"
  | "recovery_restart"
  | "user_install"
  | "normal_quit"
  | "unknown";
const events = [
  "attempt_started",
  "check_requested",
  "download_available",
  "retry_scheduled",
  "download_timeout",
  "download_completed",
  "install_requested",
  "restart_requested",
  "launch_verification",
  "no_update",
  "native_error",
  "native_error_ignored",
  "failure",
  "suspend",
  "resume",
  "offline",
  "online",
  "process_gap",
  "native_install_requested",
  "before_quit",
  "local_cleanup_started",
  "local_cleanup_finished",
  "browser_cleanup_started",
  "browser_cleanup_finished",
  "browser_cleanup_failed",
  "window_close_blocked",
  "will_quit",
] as const;
export type DiagnosticStep = (typeof events)[number];
const triggers: UpdateTrigger[] = [
  "startup",
  "scheduled",
  "automatic_retry",
  "user_retry",
  "recovery_restart",
  "user_install",
  "normal_quit",
  "unknown",
];
const codes = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENOSPC",
  "EACCES",
  "EPERM",
];
const domains = [
  "NSURLErrorDomain",
  "NSCocoaErrorDomain",
  "SQRLUpdaterErrorDomain",
  "RACCommandErrorDomain",
];
const reasons = [
  "updater_error",
  "download_timeout",
  "no_update",
  "install_refused",
  "install_threw",
  "install_timeout",
  "shutdown_stuck",
  "restart_failed",
  "recovery_expired",
  "marker_invalid",
  "marker_write_failed",
  "version_unchanged",
] as const;
type Detail = {
  reason?: (typeof reasons)[number];
  retry?: number;
  delay_ms?: number;
  trigger?: UpdateTrigger;
  code?: string;
  domain?: string;
  category?: "network" | "storage" | "native" | "unknown";
  result?: "installed" | "not_installed" | "unknown";
};
type Entry = Detail & { step: DiagnosticStep; at: number };
type Row = {
  id: string;
  started_at: number | null;
  trigger: UpdateTrigger;
  last_at: number;
  timeline: Entry[];
  observed_ms: number;
  sleep_ms: number;
  offline_ms: number;
  unknown_ms: number;
  timestamps: Partial<Record<DiagnosticStep, number>>;
};
function diagnosticLog(
  level: "info" | "warn",
  message: string,
  data?: unknown,
): void {
  try {
    log[level](message, data);
  } catch {
    /* Logging cannot block an update. */
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const number = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
function safeDetail(value: Detail): Detail {
  return {
    ...(reasons.includes(value.reason!) ? { reason: value.reason } : {}),
    ...([0, 1, 2].includes(value.retry!) ? { retry: value.retry } : {}),
    ...([30_000, 120_000].includes(value.delay_ms!)
      ? { delay_ms: value.delay_ms }
      : {}),
    ...(triggers.includes(value.trigger!) ? { trigger: value.trigger } : {}),
    ...(codes.includes(value.code!) ? { code: value.code } : {}),
    ...(domains.includes(value.domain!) ? { domain: value.domain } : {}),
    ...(["network", "storage", "native", "unknown"].includes(value.category!)
      ? { category: value.category }
      : {}),
    ...(["installed", "not_installed", "unknown"].includes(value.result!)
      ? { result: value.result }
      : {}),
  };
}
// Never persist native messages, URLs, paths, or arbitrary error properties.
export function safeUpdateError(error: unknown): Detail {
  try {
    const e = error as { code?: unknown; domain?: unknown } | null;
    const code =
      typeof e?.code === "string" && codes.includes(e.code)
        ? e.code
        : undefined;
    const domain =
      typeof e?.domain === "string" && domains.includes(e.domain)
        ? e.domain
        : undefined;
    return safeDetail({
      code,
      domain,
      category: code
        ? ["ENOSPC", "EACCES", "EPERM"].includes(code)
          ? "storage"
          : "network"
        : domain === "NSURLErrorDomain"
          ? "network"
          : domain
            ? "native"
            : "unknown",
    });
  } catch {
    return { category: "unknown" };
  }
}

/** Evidence only. This journal is never used to authorize checks, installs or restarts. */
export class UpdateDiagnostics {
  private rows: Row[] = [];
  private seen = new Set<string>();
  private active?: string;
  private timer?: ReturnType<typeof setInterval>;
  private last = Date.now();
  private sleeping = false;
  private offline = false;
  constructor(
    private file?: string,
    private online: () => boolean = () => true,
  ) {
    if (!file) return;
    try {
      const raw = fs.readFileSync(file, "utf8");
      if (raw.length > 1_000_000) throw new Error();
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows) || rows.length > 32) throw new Error();
      this.rows = rows.map((r): Row => {
        if (
          !r ||
          !uuid.test(r.id) ||
          !(r.started_at === null || number(r.started_at)) ||
          !number(r.last_at) ||
          ![r.observed_ms, r.sleep_ms, r.offline_ms, r.unknown_ms].every(
            number,
          ) ||
          !Array.isArray(r.timeline) ||
          r.timeline.length > 100 ||
          !r.timestamps ||
          typeof r.timestamps !== "object"
        )
          throw new Error();
        const timeline = r.timeline.map((e: Entry) => {
          if (!e || !events.includes(e.step) || !number(e.at))
            throw new Error();
          return { step: e.step, at: e.at, ...safeDetail(e) };
        });
        const timestamps: Row["timestamps"] = {};
        for (const step of events)
          if (number(r.timestamps[step])) timestamps[step] = r.timestamps[step];
        return {
          id: r.id,
          started_at: r.started_at,
          trigger: triggers.includes(r.trigger) ? r.trigger : "unknown",
          last_at: r.last_at,
          observed_ms: r.observed_ms,
          sleep_ms: r.sleep_ms,
          offline_ms: r.offline_ms,
          unknown_ms: r.unknown_ms,
          timeline,
          timestamps,
        };
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        diagnosticLog(
          "warn",
          "Could not read update diagnostics; history unavailable",
        );
    }
  }
  private isOnline(): boolean {
    try {
      return this.online();
    } catch {
      return false;
    }
  }
  private save(): void {
    if (!this.file) return;
    try {
      fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.rows), {
        mode: 0o600,
      });
      fs.renameSync(this.file + ".tmp", this.file);
    } catch {
      diagnosticLog("warn", "Could not save update diagnostics");
    }
  }
  private row(id: string): Row | undefined {
    if (!uuid.test(id)) return;
    let row = this.rows.find((r) => r.id === id);
    if (!row) {
      row = {
        id,
        started_at: null,
        trigger: "unknown",
        last_at: Date.now(),
        timeline: [],
        observed_ms: 0,
        sleep_ms: 0,
        offline_ms: 0,
        unknown_ms: 0,
        timestamps: {},
      };
      this.rows.push(row);
      if (this.rows.length > 32) {
        const removed = this.rows.shift();
        if (removed) this.seen.delete(removed.id);
      }
    } else if (!this.seen.has(id)) {
      row.unknown_ms += Math.max(0, Date.now() - row.last_at);
      this.append(row, "process_gap");
    }
    this.seen.add(id);
    return row;
  }
  private append(
    row: Row,
    step: DiagnosticStep,
    detail: Detail = {},
    at = Date.now(),
  ): void {
    const entry = { step, at, ...safeDetail(detail) };
    row.last_at = entry.at;
    row.timestamps[step] = entry.at;
    row.timeline.push(entry);
    row.timeline = row.timeline.slice(-100);
    diagnosticLog("info", "Desktop update step", {
      attemptId: row.id,
      ...entry,
    });
  }
  record(
    id: string,
    step: DiagnosticStep,
    detail: Detail = {},
    at = Date.now(),
  ): void {
    const row = this.row(id);
    if (!row || !events.includes(step)) return;
    if (step === "attempt_started" && row.started_at === null) {
      row.started_at = Date.now();
      row.trigger = safeDetail(detail).trigger ?? "unknown";
    }
    this.append(row, step, detail, number(at) ? at : Date.now());
    this.save();
  }
  watch(id: string): void {
    this.stop();
    if (!this.row(id)) return;
    this.active = id;
    this.last = Date.now();
    this.offline = !this.isOnline();
    this.timer = setInterval(() => this.sample(), 30_000);
    this.timer.unref?.();
  }
  private sample(): void {
    const row = this.rows.find((r) => r.id === this.active);
    if (!row) return;
    const now = Date.now(),
      elapsed = Math.max(0, now - this.last),
      offline = !this.isOnline();
    if (this.sleeping) row.sleep_ms += elapsed;
    else if (elapsed > 90_000) row.unknown_ms += elapsed;
    else if (this.offline || offline) row.offline_ms += elapsed;
    else row.observed_ms += elapsed;
    if (offline !== this.offline)
      this.append(row, offline ? "offline" : "online");
    this.offline = offline;
    this.last = row.last_at = now;
    this.save();
  }
  power(sleeping: boolean): void {
    this.sample();
    this.sleeping = sleeping;
    if (this.active) this.record(this.active, sleeping ? "suspend" : "resume");
  }
  stop(): void {
    this.sample();
    clearInterval(this.timer);
    this.timer = undefined;
    this.active = undefined;
  }
  snapshot(id: string): Record<string, unknown> {
    if (id === this.active) this.sample();
    const row = this.row(id);
    if (!row) return { history: "unavailable", byte_progress: "unavailable" };
    this.save();
    const end = row.timestamps.download_completed ?? Date.now();
    return JSON.parse(
      JSON.stringify({
        ...row,
        history: row.started_at === null ? "partial" : "recorded",
        byte_progress: "unavailable",
        attempt_elapsed_ms:
          row.started_at === null
            ? null
            : Math.max(0, Date.now() - row.started_at),
        download_elapsed_ms:
          row.timestamps.download_available === undefined
            ? null
            : Math.max(0, end - row.timestamps.download_available),
        after_timeout_ms:
          row.timestamps.download_timeout === undefined
            ? null
            : Math.max(0, end - row.timestamps.download_timeout),
      }),
    );
  }
}
let diagnostics = new UpdateDiagnostics();
export function configureUpdateDiagnostics(
  userData?: string,
  online?: () => boolean,
): void {
  diagnostics.stop();
  diagnostics = new UpdateDiagnostics(
    userData ? path.join(userData, ".update-diagnostics.json") : undefined,
    online,
  );
}
export const recordUpdateDiagnostic = (
  id: string,
  step: DiagnosticStep,
  detail?: Detail,
  at?: number,
) => diagnostics.record(id, step, detail, at);
export const updateDiagnosticSnapshot = (id: string) => {
  const snapshot = diagnostics.snapshot(id);
  // Sentry normalizes nested context objects to "[Object]". Flat JSON lines
  // retain the entire allowlisted timeline at the SDK's default depth.
  return {
    ...snapshot,
    timeline: Array.isArray(snapshot.timeline)
      ? snapshot.timeline.map((entry) => JSON.stringify(entry))
      : [],
  };
};
export const watchUpdateDownload = (id: string) => diagnostics.watch(id);
export const stopUpdateDownloadWatch = () => diagnostics.stop();
export const recordUpdatePower = (sleeping: boolean) =>
  diagnostics.power(sleeping);
