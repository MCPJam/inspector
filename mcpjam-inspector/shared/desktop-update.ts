/** Type-only contract shared by Electron main, its preload and the renderer. */
export type UpdateFailureReason =
  | "updater_error"
  | "download_timeout"
  | "no_update"
  | "install_refused"
  | "install_threw"
  | "install_timeout"
  | "shutdown_stuck"
  | "restart_failed"
  | "recovery_expired"
  | "marker_invalid"
  | "marker_write_failed"
  | "version_unchanged";

export type FailedUpdateStatus = {
  kind: "failed";
  attemptId: string;
  reason: UpdateFailureReason;
  action: "retry-download" | "relaunch-retry" | "instructions";
  version?: string;
};

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "pending"; version?: string; installRequested: boolean }
  | { kind: "retry-waiting"; version?: string; retry: number }
  | { kind: "downloaded"; version: string; releaseNotes?: string }
  | { kind: "recovering"; attemptId: string; version?: string }
  | FailedUpdateStatus;
