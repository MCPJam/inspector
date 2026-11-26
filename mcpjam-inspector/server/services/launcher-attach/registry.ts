import type {
  LauncherAttachRequest,
  LauncherAttachResult,
  LauncherAttachState,
  LauncherAttachStatus,
  LauncherDecision,
  LauncherPollResponse,
  LauncherReleaseState,
  LauncherTabPoll,
  LauncherTabProject,
  LauncherTask,
} from "../../../shared/launcher-attach.js";

/** A tab that has not polled for this long is treated as closed. */
export const TAB_TTL_MS = 6_000;
/** A tab that received a request and has not claimed it loses it after this. */
export const CLAIM_TIMEOUT_MS = 5_000;
/** Open requests, undelivered releases and abandoned requests, each; a runaway caller cannot grow memory. */
export const MAX_ATTACH_REQUESTS = 100;
/** How long a request released mid-save waits for its tab to report what it saved. */
export const ABANDONED_TTL_MS = 5 * 60_000;

interface TabRecord extends LauncherTabPoll {
  lastSeen: number;
}

type LiveTab = TabRecord & { tabId: string };

interface Assignment {
  tabId?: string;
  /** When the assigned tab first received the task. */
  deliveredAt?: number;
  /** Tabs that let the claim time out, skipped until every live tab has. */
  skipped: Set<string>;
}

interface AttachRecord extends Assignment {
  request: LauncherAttachRequest;
  status: LauncherAttachStatus;
  claimedBy?: string;
  /** Every tab that ever claimed this request, so a late report can be undone. */
  claimants: Set<string>;
  /** The project the developer picked in another tab. */
  targetProjectId?: string;
  decision?: LauncherDecision;
  message?: string;
}

interface ReleaseRecord extends Assignment {
  attachId: string;
  request: LauncherAttachRequest;
  decision: LauncherDecision;
}

/** A request released while a tab was still saving it. */
interface AbandonedRecord {
  request: LauncherAttachRequest;
  tabId: string;
  at: number;
  /** The undo has been queued; later reports from the tab need no second one. */
  undone: boolean;
}

export type LauncherRegistryError =
  | "unknown_attach"
  | "not_assigned"
  | "too_many_requests";

export interface LauncherRegistryOptions {
  now?: () => number;
  /** Whether a dev command process is still running. */
  isPidAlive?: (pid: number) => boolean;
}

/**
 * Hands each dev command's attach request to exactly one open tab, remembers
 * where the server was saved, and hands the undo to a tab when the dev
 * command quits.
 *
 * Everything the attach saved must be undone when the dev command quits, so
 * the registry never forgets a saved entry: a tab reports the save before it
 * connects, a release that arrives mid-save waits for that report, and an
 * undo with no tab to apply it is kept until a tab shows the project.
 *
 * State is in memory: if MCPJam restarts, saved entries stay saved and
 * disconnected, and a dev command that attaches again is treated as new.
 */
export class LauncherAttachRegistry {
  private readonly tabs = new Map<string, TabRecord>();
  private readonly attaches = new Map<string, AttachRecord>();
  /** Keyed by `attachId|projectId`: one attach can leave entries in two projects. */
  private readonly releases = new Map<string, ReleaseRecord>();
  private readonly abandoned = new Map<string, AbandonedRecord>();
  /** Tabs that must drop an attach request they were working on. */
  private readonly cancelled = new Map<string, Set<string>>();
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number) => boolean;

  constructor(options: LauncherRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  }

  attach(
    request: LauncherAttachRequest,
  ): { ok: true; state: LauncherAttachState } | { ok: false; error: LauncherRegistryError } {
    const existing = this.attaches.get(request.attachId);
    if (!existing && this.attaches.size >= MAX_ATTACH_REQUESTS) {
      return { ok: false, error: "too_many_requests" };
    }
    // The same dev command asking again while a tab is still working on it,
    // for example a Vite restart mid-connect. The id is the server's identity,
    // so this is the same request: leave it be, or the tab's save would be
    // treated as stale and undone.
    if (existing && (existing.status === "pending" || existing.status === "claimed")) {
      existing.request = request;
      return { ok: true, state: this.state(request.attachId)! };
    }
    // A restart that released and attached again before any tab undid the
    // release keeps its entry: the undo is dropped and the decision reused.
    let decision = existing?.decision;
    for (const [key, release] of this.releases) {
      if (release.attachId !== request.attachId || release.deliveredAt) continue;
      this.releases.delete(key);
      decision ??= release.decision;
    }
    this.abandoned.delete(request.attachId);
    this.attaches.set(request.attachId, {
      request,
      status: "pending",
      skipped: new Set(),
      claimants: new Set(existing?.claimants),
      ...(decision ? { decision } : {}),
    });
    this.assign();
    return { ok: true, state: this.state(request.attachId)! };
  }

  /** The dev command quit or called `stop()`. */
  release(attachId: string): boolean {
    const record = this.attaches.get(attachId);
    if (!record) return false;
    this.attaches.delete(attachId);
    if (record.claimedBy && !record.decision) {
      // The tab may be saving the server right now. Tell it to stop, and
      // remember it: whatever it reports having saved is undone below.
      this.cancel(record.claimedBy, attachId);
      this.remember(attachId, {
        request: record.request,
        tabId: record.claimedBy,
        at: this.now(),
        undone: false,
      });
    }
    if (record.decision) {
      this.queueRelease(attachId, record.request, record.decision);
      this.assign();
    }
    return true;
  }

  state(attachId: string): LauncherAttachState | undefined {
    const record = this.attaches.get(attachId);
    if (!record) return undefined;
    return {
      attachId,
      status: record.status,
      serverName: record.request.server.name,
      ...(record.decision ? { projectName: record.decision.projectName } : {}),
      ...(record.message ? { message: record.message } : {}),
    };
  }

  /**
   * Whether a tab still has to undo what this attach added. A caller about to
   * stop MCPJam waits for `done`, or the entry would stay saved.
   */
  releaseState(attachId: string): LauncherReleaseState {
    this.pruneAbandoned();
    const queued = [...this.releases.values()].some((r) => r.attachId === attachId);
    const saving = this.abandoned.get(attachId)?.undone === false;
    return { status: queued || saving ? "pending" : "done" };
  }

  poll(tabId: string, poll: LauncherTabPoll): LauncherPollResponse {
    this.tabs.set(tabId, { ...poll, lastSeen: this.now() });
    this.assign();
    const now = this.now();
    const tasks: LauncherTask[] = [];
    const openProjects = this.openProjects();
    for (const [attachId, record] of this.attaches) {
      if (record.status !== "pending" || record.tabId !== tabId) continue;
      record.deliveredAt ??= now;
      tasks.push({
        kind: "attach",
        attachId,
        server: record.request.server,
        openProjects,
        ...(record.decision ? { decision: record.decision } : {}),
        ...(record.targetProjectId
          ? { targetProjectId: record.targetProjectId }
          : {}),
      });
    }
    for (const record of this.releases.values()) {
      if (record.tabId !== tabId) continue;
      record.deliveredAt ??= now;
      tasks.push({
        kind: "release",
        attachId: record.attachId,
        server: record.request.server,
        decision: record.decision,
      });
    }
    const cancelledAttachIds = [...(this.cancelled.get(tabId) ?? [])];
    this.cancelled.delete(tabId);
    const waitingForSignIn =
      poll.signedIn || this.liveTabs().some((tab) => tab.signedIn)
        ? []
        : [...this.attaches]
            .filter(([, record]) => record.status === "pending")
            .map(([attachId, record]) => ({
              attachId,
              serverName: record.request.server.name,
            }));
    return { tasks, cancelledAttachIds, waitingForSignIn };
  }

  closeTab(tabId: string): void {
    this.tabs.delete(tabId);
    this.cancelled.delete(tabId);
    this.assign();
  }

  /** The assigned tab takes the request; no other tab will act on it. */
  claim(attachId: string, tabId: string): LauncherRegistryError | undefined {
    const record = this.attaches.get(attachId);
    if (!record) return "unknown_attach";
    if (record.status !== "pending" || record.tabId !== tabId) {
      return "not_assigned";
    }
    record.status = "claimed";
    record.claimedBy = tabId;
    record.claimants.add(tabId);
    return undefined;
  }

  /** The developer picked a project another tab shows; that tab saves it. */
  route(
    attachId: string,
    tabId: string,
    projectId: string,
  ): LauncherRegistryError | undefined {
    const record = this.attaches.get(attachId);
    if (!record) return "unknown_attach";
    if (record.claimedBy !== tabId) return "not_assigned";
    this.attaches.set(attachId, {
      request: record.request,
      status: "pending",
      skipped: new Set(),
      claimants: record.claimants,
      targetProjectId: projectId,
      ...(record.decision ? { decision: record.decision } : {}),
    });
    this.assign();
    return undefined;
  }

  result(
    attachId: string,
    result: LauncherAttachResult,
  ): LauncherRegistryError | undefined {
    const record = this.attaches.get(attachId);
    if (!record) return this.lateReport(attachId, result);
    if (record.claimedBy !== result.tabId) return this.supersededReport(record, result);
    if (result.decision) {
      record.decision = mergeDecision(record.decision, result.decision);
    }
    // `saved` is a checkpoint: the tab is still connecting.
    if (result.outcome === "saved") return undefined;
    record.status = result.outcome;
    if (result.outcome === "failed") record.message = result.message;
    else delete record.message;
    return undefined;
  }

  /** A tab finished undoing a quit dev command's attach. */
  released(attachId: string, tabId: string): LauncherRegistryError | undefined {
    const mine = [...this.releases].filter(
      ([, record]) => record.attachId === attachId && record.tabId === tabId,
    );
    if (mine.length === 0) return "unknown_attach";
    for (const [key] of mine) this.releases.delete(key);
    return undefined;
  }

  /** Releases requests whose dev command is no longer running. */
  sweep(): void {
    for (const [attachId, record] of [...this.attaches]) {
      const pid = record.request.pid;
      if (pid !== undefined && !this.isPidAlive(pid)) this.release(attachId);
    }
  }

  /**
   * A report for a request that was released while the tab worked on it. If
   * the tab saved something, it is undone by that same tab, which still has it.
   */
  private lateReport(
    attachId: string,
    result: LauncherAttachResult,
  ): LauncherRegistryError | undefined {
    this.pruneAbandoned();
    const abandoned = this.abandoned.get(attachId);
    if (!abandoned || abandoned.tabId !== result.tabId) return "unknown_attach";
    if (result.decision && !abandoned.undone) {
      this.queueRelease(attachId, abandoned.request, result.decision, result.tabId);
      abandoned.undone = true;
    }
    // `saved` may be followed by `connected` or `failed`; the entry is kept
    // until that final report so the engine's wait stays accurate.
    if (result.outcome !== "saved") this.abandoned.delete(attachId);
    return undefined;
  }

  /**
   * A report from a tab that no longer holds the request, such as one that
   * slept or reloaded and lost its claim. What it saved was saved: the same
   * entry the current tab uses is credited to the attach, and one in another
   * project is undone by the tab that saved it.
   */
  private supersededReport(
    record: AttachRecord,
    result: LauncherAttachResult,
  ): LauncherRegistryError | undefined {
    const { decision } = result;
    if (!record.claimants.has(result.tabId) || !decision) return "not_assigned";
    if (record.decision && sameEntry(record.decision, decision)) {
      record.decision = mergeDecision(record.decision, decision);
    } else if (decision.createdByAttach) {
      this.queueRelease(record.request.attachId, record.request, decision, result.tabId);
    }
    return undefined;
  }

  private queueRelease(
    attachId: string,
    request: LauncherAttachRequest,
    decision: LauncherDecision,
    tabId?: string,
  ) {
    const key = `${attachId}|${decision.projectId}`;
    if (this.releases.has(key)) return;
    if (this.releases.size >= MAX_ATTACH_REQUESTS) {
      const oldest = this.releases.keys().next().value;
      if (oldest !== undefined) this.releases.delete(oldest);
    }
    this.releases.set(key, {
      attachId,
      request,
      decision,
      skipped: new Set(),
      ...(tabId ? { tabId } : {}),
    });
  }

  private remember(attachId: string, record: AbandonedRecord) {
    this.pruneAbandoned();
    if (this.abandoned.size >= MAX_ATTACH_REQUESTS) {
      const oldest = this.abandoned.keys().next().value;
      if (oldest !== undefined) this.abandoned.delete(oldest);
    }
    this.abandoned.set(attachId, record);
  }

  private pruneAbandoned() {
    const cutoff = this.now() - ABANDONED_TTL_MS;
    for (const [attachId, record] of this.abandoned) {
      if (record.at < cutoff) this.abandoned.delete(attachId);
    }
  }

  private cancel(tabId: string, attachId: string) {
    const set = this.cancelled.get(tabId) ?? new Set<string>();
    set.add(attachId);
    this.cancelled.set(tabId, set);
  }

  private liveTabs(): LiveTab[] {
    const cutoff = this.now() - TAB_TTL_MS;
    const live: LiveTab[] = [];
    for (const [tabId, tab] of this.tabs) {
      if (tab.lastSeen >= cutoff) live.push({ ...tab, tabId });
      else this.tabs.delete(tabId);
    }
    return live;
  }

  private openProjects(): LauncherTabProject[] {
    const byId = new Map<string, LauncherTabProject>();
    for (const tab of this.liveTabs()) {
      if (tab.signedIn && tab.project) byId.set(tab.project.id, tab.project);
    }
    return [...byId.values()];
  }

  private assign() {
    const now = this.now();
    const signedIn = this.liveTabs().filter((tab) => tab.signedIn);
    const liveIds = new Set(signedIn.map((tab) => tab.tabId));

    for (const [attachId, record] of this.attaches) {
      if (record.status === "claimed" && !liveIds.has(record.claimedBy!)) {
        // The tab that took it closed, slept or reloaded before finishing.
        // If it comes back it must drop the request it was working on, and
        // anything it saved is dealt with when it reports (supersededReport).
        this.cancel(record.claimedBy!, attachId);
        record.status = "pending";
        delete record.claimedBy;
        delete record.tabId;
        delete record.deliveredAt;
      }
      if (record.status !== "pending") continue;
      const target = record.targetProjectId;
      if (target && !signedIn.some((tab) => tab.project?.id === target)) {
        // The tab showing the chosen project closed; ask again elsewhere.
        delete record.targetProjectId;
      }
      this.assignOne(
        record,
        signedIn,
        now,
        record.targetProjectId ?? record.decision?.projectId,
        { strict: record.targetProjectId !== undefined, canTimeOut: true },
      );
    }

    for (const record of this.releases.values()) {
      const showing = signedIn.filter(
        (tab) => tab.project?.id === record.decision.projectId,
      );
      if (showing.length === 0) {
        // Only a tab showing the project can remove the entry. The undo is
        // kept, not dropped, until one is open: the entry was promised gone.
        delete record.tabId;
        delete record.deliveredAt;
        continue;
      }
      // A release has no claim step, so it is never handed to a second tab
      // while the first is alive but busy: two tabs would both apply it.
      this.assignOne(record, showing, now, record.decision.projectId, {
        strict: false,
        canTimeOut: false,
      });
    }
  }

  private assignOne(
    record: Assignment,
    candidates: LiveTab[],
    now: number,
    preferredProjectId: string | undefined,
    mode: { strict: boolean; canTimeOut: boolean },
  ) {
    if (record.tabId) {
      const stillLive = candidates.some((tab) => tab.tabId === record.tabId);
      const timedOut =
        mode.canTimeOut &&
        record.deliveredAt !== undefined &&
        now - record.deliveredAt > CLAIM_TIMEOUT_MS;
      if (stillLive && !timedOut) return;
      if (timedOut) record.skipped.add(record.tabId);
      delete record.tabId;
      delete record.deliveredAt;
    }
    const showing = preferredProjectId
      ? candidates.filter((tab) => tab.project?.id === preferredProjectId)
      : [];
    let pool: LiveTab[];
    if (mode.strict && showing.length > 0) {
      // The developer chose this project: while a live tab shows it, no other
      // tab takes the request, even if the first one is slow to claim.
      pool = showing.filter((tab) => !record.skipped.has(tab.tabId));
      if (pool.length === 0) {
        record.skipped.clear();
        pool = showing;
      }
    } else {
      pool = candidates.filter((tab) => !record.skipped.has(tab.tabId));
      if (pool.length === 0 && candidates.length > 0) {
        record.skipped.clear();
        pool = candidates;
      }
      const preferred = pool.filter((tab) => showing.includes(tab));
      if (preferred.length > 0) pool = preferred;
    }
    const best = pool.reduce<LiveTab | undefined>(
      (a, b) => (!a || b.focusedAt > a.focusedAt ? b : a),
      undefined,
    );
    if (best) record.tabId = best.tabId;
  }
}

function sameEntry(a: LauncherDecision, b: LauncherDecision): boolean {
  return a.projectId === b.projectId && a.serverName === b.serverName;
}

/** Once an attach has created an entry it stays credited with it. */
function mergeDecision(
  existing: LauncherDecision | undefined,
  incoming: LauncherDecision,
): LauncherDecision {
  if (!existing || !sameEntry(existing, incoming)) return incoming;
  return {
    ...incoming,
    createdByAttach: existing.createdByAttach || incoming.createdByAttach,
  };
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
