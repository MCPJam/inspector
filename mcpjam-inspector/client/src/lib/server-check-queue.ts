import { useSyncExternalStore } from "react";

export type CheckQueueState = "queued" | "connecting" | undefined;
type Job = {
  key: string;
  projectId: string;
  serverName: string;
  scope: string;
  automatic: boolean;
  controller: AbortController;
  attempt?: AbortController;
  started?: number;
  manualOrder: number;
  promote?: () => Promise<void>;
  requestId?: string;
  state: CheckQueueState;
  readyAt: number;
  retryStarted?: number;
  resumed?: boolean;
  run: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  promise: Promise<unknown>;
  detach?: () => void;
};
export const preemptedCheck = () =>
  Object.assign(new Error("Automatic check interrupted"), {
    status: 409,
    details: { reason: "SERVER_CHECK_PREEMPTED" },
  });
export const isPreemptedCheck = (error: unknown) =>
  (error as { details?: { reason?: string } } | null)?.details?.reason ===
  "SERVER_CHECK_PREEMPTED";
const cancelError = () =>
  new DOMException("Server check cancelled", "AbortError");

export class ServerCheckQueue {
  private jobs = new Map<string, Job>();
  private running = 0;
  private sequence = 0;
  private attempts = new WeakMap<AbortSignal, Job>();
  attemptMetadata(signal: AbortSignal) {
    const job = this.attempts.get(signal);
    return job
      ? {
          requestId: job.requestId!,
          resumed: job.resumed ?? false,
          intent: job.automatic ? ("automatic" as const) : ("manual" as const),
        }
      : undefined;
  }
  bindPromotion(signal: AbortSignal, promote: () => Promise<void>) {
    const job = this.attempts.get(signal);
    if (job) job.promote = promote;
    return () => {
      if (job?.promote === promote) job.promote = undefined;
    };
  }
  private interrupt(job: Job) {
    if (!job.attempt || job.attempt.signal.aborted) return;
    for (const listener of this.cancelListeners)
      listener(job.projectId, job.serverName);
    job.attempt.abort(preemptedCheck());
  }
  private listeners = new Set<() => void>();
  private cancelListeners = new Set<
    (projectId: string, name: string) => void
  >();
  onCancel(listener: (projectId: string, name: string) => void) {
    this.cancelListeners.add(listener);
    return () => {
      this.cancelListeners.delete(listener);
    };
  }
  private abort(job: Job, reason: unknown = cancelError()) {
    if (job.controller.signal.aborted) return;
    for (const listener of this.cancelListeners)
      listener(job.projectId, job.serverName);
    job.controller.abort(reason);
    if (job.state === "queued") this.finish(job, undefined, reason);
  }
  private orders = new Map<string, string[]>();
  private scopes = new Map<string, string>();
  private automatic = new Set<string>();
  private automaticDisabled = new Set<string>();
  setAutomaticEnabled(projectId: string, enabled: boolean) {
    if (enabled) this.automaticDisabled.delete(projectId);
    else {
      this.automaticDisabled.add(projectId);
      for (const key of this.automatic) {
        if (JSON.parse(key)[0] === projectId) this.automatic.delete(key);
      }
      this.cancelAutomatic(projectId);
    }
  }
  private wake?: ReturnType<typeof setTimeout>;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  state(projectId: string, name: string): CheckQueueState {
    const jobs = [...this.jobs.values()].filter(
      (j) => j.projectId === projectId && j.serverName === name,
    );
    return jobs.some((j) => j.state === "connecting")
      ? "connecting"
      : jobs.length
        ? "queued"
        : undefined;
  }
  setOrder(projectId: string, names: string[]) {
    this.orders.set(projectId, names);
    this.drainSoon();
  }
  setScope(projectId: string, scope: string) {
    const old = this.scopes.get(projectId);
    if (old !== undefined && old !== scope)
      this.cancel((j) => j.projectId === projectId);
    this.scopes.set(projectId, scope);
  }
  markAutomatic(projectId: string, names: string[]) {
    for (const name of names)
      this.automatic.add(JSON.stringify([projectId, name]));
  }
  markManual(projectId: string, name: string) {
    this.automatic.delete(JSON.stringify([projectId, name]));
    for (const job of this.jobs.values()) {
      if (
        job.projectId !== projectId ||
        job.serverName !== name ||
        !job.automatic
      )
        continue;
      job.automatic = false;
      job.manualOrder = ++this.sequence;
      const attempt = job.attempt;
      if (job.promote)
        void job.promote().catch(() => {
          // Retry as manual if promotion cannot be acknowledged. Admission still
          // waits for the old backend lease to be released before opening MCP.
          if (
            this.jobs.get(job.key) === job &&
            job.attempt === attempt &&
            !job.controller.signal.aborted
          )
            this.interrupt(job);
        });
    }
    this.drainSoon();
  }
  cancelAutomatic(projectId: string) {
    this.cancel(
      (j) => j.projectId === projectId && j.automatic && j.state === "queued",
    );
  }
  cancelServer(projectId: string, name: string) {
    this.cancel((j) => j.projectId === projectId && j.serverName === name);
  }
  keepServers(projectId: string, names: string[]) {
    const allowed = new Set(names);
    this.cancel((j) => j.projectId === projectId && !allowed.has(j.serverName));
  }
  keepProject(projectId: string) {
    this.cancel((j) => j.projectId !== projectId);
  }
  cancelAll() {
    this.cancel(() => true);
  }
  private cancel(predicate: (job: Job) => boolean) {
    for (const job of this.jobs.values())
      if (predicate(job)) {
        this.abort(job);
      }
  }
  run<T>(
    options: {
      projectId: string;
      serverName: string;
      identity: string;
      signal?: AbortSignal;
    },
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const scope = this.scopes.get(options.projectId) ?? "-";
    const key = JSON.stringify([
      options.projectId,
      scope,
      options.serverName,
      options.identity,
    ]);
    const existing = this.jobs.get(key);
    if (existing && !existing.controller.signal.aborted) {
      this.automatic.delete(
        JSON.stringify([options.projectId, options.serverName]),
      );
      return existing.promise as Promise<T>;
    }
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    let resolve!: Job["resolve"];
    let reject!: Job["reject"];
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: Job = {
      ...options,
      key,
      scope,
      automatic: this.automatic.delete(
        JSON.stringify([options.projectId, options.serverName]),
      ),
      manualOrder: ++this.sequence,
      controller: new AbortController(),
      state: "queued",
      readyAt: 0,
      run,
      resolve,
      reject,
      promise,
    };
    if (options.signal) {
      const abort = () =>
        this.abort(job, options.signal!.reason ?? cancelError());
      options.signal.addEventListener("abort", abort, { once: true });
      job.detach = () => options.signal!.removeEventListener("abort", abort);
    }
    if (job.automatic && this.automaticDisabled.has(job.projectId)) {
      this.abort(job);
      return promise as Promise<T>;
    }
    this.jobs.set(key, job);
    this.emit();
    this.drainSoon();
    return promise as Promise<T>;
  }
  private drainSoon() {
    queueMicrotask(() => this.drain());
  }
  private drain() {
    clearTimeout(this.wake);
    const pending = [...this.jobs.values()].filter((j) => j.state === "queued");
    pending.sort((a, b) => {
      if (a.automatic !== b.automatic) return a.automatic ? 1 : -1;
      if (!a.automatic) return a.manualOrder - b.manualOrder;
      if (a.projectId !== b.projectId) return 0;
      const order = this.orders.get(a.projectId) ?? [];
      const rank = (name: string) => {
        const i = order.indexOf(name);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      };
      return rank(a.serverName) - rank(b.serverName);
    });
    for (const job of pending) {
      if (this.running >= 10) break;
      if (job.readyAt > Date.now()) continue;
      this.running++;
      job.state = "connecting";
      job.started = ++this.sequence;
      job.attempt = new AbortController();
      job.requestId = crypto.randomUUID();
      const attemptSignal = AbortSignal.any([
        job.controller.signal,
        job.attempt.signal,
      ]);
      this.attempts.set(attemptSignal, job);
      const requeuePreempted = () => {
        if (job.controller.signal.aborted) return false;
        if (job.automatic && this.automaticDisabled.has(job.projectId)) {
          this.abort(job);
          return false;
        }
        for (const listener of this.cancelListeners)
          listener(job.projectId, job.serverName);
        job.state = "queued";
        job.resumed = true;
        job.readyAt = Date.now() + (job.automatic ? 500 : 0);
        this.emit();
        return true;
      };
      this.emit();
      void Promise.resolve()
        .then(() => {
          attemptSignal.throwIfAborted();
          return job.run(attemptSignal);
        })
        .then(
          (value) => {
            if (isPreemptedCheck(attemptSignal.reason) && requeuePreempted())
              return;
            this.finish(
              job,
              value,
              job.controller.signal.aborted
                ? job.controller.signal.reason
                : undefined,
            );
          },
          (error) => {
            if (
              (isPreemptedCheck(error) ||
                isPreemptedCheck(attemptSignal.reason)) &&
              requeuePreempted()
            )
              return;
            if (
              job.automatic &&
              this.automaticDisabled.has(job.projectId) &&
              isServerCheckQueueError(error)
            ) {
              this.abort(job);
              this.finish(job, undefined, job.controller.signal.reason);
              return;
            }
            const reason = error?.details?.reason;
            if (
              !job.controller.signal.aborted &&
              error?.status === 429 &&
              [
                "SERVER_CHECK_QUEUE_FULL",
                "SERVER_CHECK_QUEUE_TIMEOUT",
              ].includes(reason)
            ) {
              job.retryStarted ??= Date.now();
              const wait =
                Math.max(2000, Number(error.retryAfterMs) || 2000) +
                Math.random() * 250;
              if (Date.now() + wait - job.retryStarted < 120_000) {
                job.state = "queued";
                job.readyAt = Date.now() + wait;
                this.emit();
                return;
              }
              error = new Error(
                "Server checks are still busy. Click Connect to retry.",
              );
            }
            this.finish(
              job,
              undefined,
              job.controller.signal.aborted
                ? job.controller.signal.reason
                : error,
            );
          },
        )
        .finally(() => {
          job.promote = undefined;
          this.attempts.delete(attemptSignal);
          this.running--;
          this.drainSoon();
        });
    }
    // Each pending manual needs one slot, including interruptions already
    // underway. Do not cancel active manual checks or over-cancel a batch.
    const active = [...this.jobs.values()].filter(
      (j) => j.state === "connecting",
    );
    let needed =
      pending.filter(
        (j) => !j.automatic && j.state === "queued" && j.readyAt <= Date.now(),
      ).length - active.filter((j) => j.attempt?.signal.aborted).length;
    for (const job of active.sort(
      (a, b) => (b.started ?? 0) - (a.started ?? 0),
    )) {
      if (needed <= 0) break;
      if (job.automatic && !job.attempt?.signal.aborted) {
        this.interrupt(job);
        needed--;
      }
    }
    const delayed = [...this.jobs.values()].filter(
      (j) => j.state === "queued" && j.readyAt > Date.now(),
    );
    if (delayed.length)
      this.wake = setTimeout(
        () => this.drain(),
        Math.max(1, Math.min(...delayed.map((j) => j.readyAt)) - Date.now()),
      );
  }
  private finish(job: Job, value?: unknown, error?: unknown) {
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    job.detach?.();
    if (error !== undefined) job.reject(error);
    else job.resolve(value);
    this.emit();
  }
}
export const serverCheckQueue = new ServerCheckQueue();
export function useServerCheckQueueState(projectId: string, name: string) {
  return useSyncExternalStore(
    serverCheckQueue.subscribe,
    () => serverCheckQueue.state(projectId, name),
    () => undefined,
  );
}

export function loadServerOrder(projectId: string): string[] | undefined {
  try {
    const order = JSON.parse(localStorage.getItem("mcp-server-order") ?? "{}")[
      projectId
    ];
    return Array.isArray(order)
      ? order.filter((n) => typeof n === "string")
      : undefined;
  } catch {
    return undefined;
  }
}
export function saveServerOrder(projectId: string, names: string[]) {
  try {
    const all = JSON.parse(localStorage.getItem("mcp-server-order") ?? "{}");
    all[projectId] = names;
    localStorage.setItem("mcp-server-order", JSON.stringify(all));
  } catch {
    /* Storage may be disabled. */
  }
  serverCheckQueue.setOrder(projectId, names);
}

export function isServerCheckQueueError(error: unknown): boolean {
  const candidate = error as {
    status?: number;
    details?: { reason?: string };
  } | null;
  return (
    isPreemptedCheck(error) ||
    (candidate?.status === 429 &&
      ["SERVER_CHECK_QUEUE_FULL", "SERVER_CHECK_QUEUE_TIMEOUT"].includes(
        candidate.details?.reason ?? "",
      ))
  );
}
