import { track } from "./analytics";

export type ExtensionLaunchKind =
  | "thread"
  | "global"
  | "file"
  | "quick-action"
  | "settings";
export type ExtensionLaunchProfile = "chatgpt" | "codex";
export type ExtensionLaunchFailure =
  | "execution"
  | "rendering"
  | "timeout"
  | "unknown";
export type ExtensionLaunchOutcome = {
  launch_kind: ExtensionLaunchKind;
  host_profile: ExtensionLaunchProfile;
  outcome: "success" | "failure";
  failure_stage: ExtensionLaunchFailure | "none";
};
export interface ExtensionLaunchObservation {
  /** Call after execution has returned an App, not while awaiting human approval. */
  awaitingReadiness(): void;
  /** The initial guest handshake/render succeeded. Later interactions are not launches. */
  ready(): void;
  fail(stage: ExtensionLaunchFailure): void;
  /** Only deliberate cancellation or an expected policy/approval denial. */
  exclude(): void;
}
const UNOBSERVED: ExtensionLaunchObservation = {
  awaitingReadiness() {},
  ready() {},
  fail() {},
  exclude() {},
};

/**
 * One registry per retained workspace owner, not per React render or visible tab.
 * Use the original activation operation ID for retries/reopen. IDs never leave
 * this registry. Completed entries are tombstones until owner disposal: eviction
 * would turn a cached reopen into a second launch. At capacity only telemetry is
 * skipped; product actions must remain available.
 */
export class ExtensionLaunchHealth {
  private readonly launches = new Map<string, ExtensionLaunchObservation>();
  private readonly pending = new Set<ExtensionLaunchObservation>();
  private disposed = false;

  constructor(
    private readonly emit: (outcome: ExtensionLaunchOutcome) => void = (
      outcome,
    ) =>
      track("extension_launch_completed", {
        ...outcome,
        location: "host_workspace",
      }),
    private readonly readinessTimeoutMs = 30_000,
    private readonly capacity = 4096,
  ) {}

  begin(
    operationId: string,
    kind: ExtensionLaunchKind,
    profile: ExtensionLaunchProfile,
  ): ExtensionLaunchObservation {
    const existing = this.launches.get(operationId);
    if (existing) return existing;
    if (this.disposed || this.launches.size >= this.capacity) return UNOBSERVED;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (failure?: ExtensionLaunchFailure, excluded = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.pending.delete(observation);
      if (!excluded) {
        // Analytics failures cannot change launch state or trigger retries.
        try {
          this.emit({
            launch_kind: kind,
            host_profile: profile,
            outcome: failure ? "failure" : "success",
            failure_stage: failure ?? "none",
          });
        } catch {
          /* best effort */
        }
      }
    };
    const observation: ExtensionLaunchObservation = {
      awaitingReadiness: () => {
        if (!settled && !timer)
          timer = setTimeout(() => finish("timeout"), this.readinessTimeoutMs);
      },
      ready: () => finish(),
      fail: (stage) => finish(stage),
      exclude: () => finish(undefined, true),
    };
    this.launches.set(operationId, observation);
    this.pending.add(observation);
    return observation;
  }

  /** Owner teardown is deliberately cancelled unless the outcome is uncertain. */
  dispose(reason: "cancelled" | "unknown" = "cancelled"): void {
    this.disposed = true;
    for (const observation of this.pending) {
      if (reason === "unknown") observation.fail("unknown");
      else observation.exclude();
    }
    this.launches.clear();
  }
}
