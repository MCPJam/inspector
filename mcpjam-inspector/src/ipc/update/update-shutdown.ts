// Allowlisted timings only: no window titles, URLs, paths, or native errors.
export type ShutdownStage =
  | "native_install_requested"
  | "before_quit"
  | "local_cleanup_started"
  | "local_cleanup_finished"
  | "browser_cleanup_started"
  | "browser_cleanup_finished"
  | "browser_cleanup_failed"
  | "window_close_blocked"
  | "will_quit";
let started: number | undefined;
let stages: Partial<Record<ShutdownStage, number>> = {};
export function beginUpdateShutdown(): void {
  started = Date.now();
  stages = {};
  recordUpdateShutdown("native_install_requested");
}
export function recordUpdateShutdown(stage: ShutdownStage): void {
  if (started !== undefined && stages[stage] === undefined)
    stages[stage] = Math.max(0, Date.now() - started);
}
export function updateShutdownSnapshot(): Record<string, number> {
  return { ...stages };
}
