import type {
  LauncherAttachRequest,
  LauncherAttachResult,
  LauncherAttachState,
  LauncherAttachStatus,
  LauncherDecision,
  LauncherPollResponse,
  LauncherTabPoll,
  LauncherTabProject,
  LauncherTask,
} from "../../../shared/launcher-attach.js";

/** A tab that has not polled for this long is treated as closed. */
export const TAB_TTL_MS = 6_000;
/** A tab that received a request and has not claimed it loses it after this. */
export const CLAIM_TIMEOUT_MS = 5_000;
/** Open attach requests per MCPJam; a runaway caller cannot grow memory. */
export const MAX_ATTACH_REQUESTS = 100;

interface TabRecord extends LauncherTabPoll {
  lastSeen: number;
}

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
  /** The project the developer picked in another tab. */
  targetProjectId?: string;
  decision?: LauncherDecision;
  message?: string;
}

interface ReleaseRecord extends Assignment {
  request: LauncherAttachRequest;
  decision: LauncherDecision;
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
 * State is in memory: if MCPJam restarts, saved entries stay saved and
 * disconnected, and a dev command that attaches again is treated as new.
 */
export class LauncherAttachRegistry {
  private readonly tabs = new Map<string, TabRecord>();
  private readonly attaches = new Map<string, AttachRecord>();
  private readonly releases = new Map<string, ReleaseRecord>();
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
    // A restart that released and attached again before any tab undid the
    // release keeps its entry: the undo is dropped and the decision reused.
    const pendingRelease = this.releases.get(request.attachId);
    if (pendingRelease && !pendingRelease.deliveredAt) {
      this.releases.delete(request.attachId);
    }
    const decision = existing?.decision ?? pendingRelease?.decision;
    if (existing?.claimedBy) {
      this.cancel(existing.claimedBy, request.attachId);
    }
    this.attaches.set(request.attachId, {
      request,
      status: "pending",
      skipped: new Set(),
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
      this.cancel(record.claimedBy, attachId);
    }
    if (record.decision) {
      this.releases.set(attachId, {
        request: record.request,
        decision: record.decision,
        skipped: new Set(),
      });
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
    for (const [attachId, record] of this.releases) {
      if (record.tabId !== tabId) continue;
      record.deliveredAt ??= now;
      tasks.push({
        kind: "release",
        attachId,
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
    if (!record) return "unknown_attach";
    if (record.claimedBy !== result.tabId) return "not_assigned";
    record.status = result.outcome;
    if (result.decision) record.decision = result.decision;
    if (result.outcome === "failed") record.message = result.message;
    else delete record.message;
    return undefined;
  }

  /** A tab finished undoing a quit dev command's attach. */
  released(attachId: string, tabId: string): LauncherRegistryError | undefined {
    const record = this.releases.get(attachId);
    if (!record) return "unknown_attach";
    if (record.tabId !== tabId) return "not_assigned";
    this.releases.delete(attachId);
    return undefined;
  }

  /** Releases requests whose dev command is no longer running. */
  sweep(): void {
    for (const [attachId, record] of [...this.attaches]) {
      const pid = record.request.pid;
      if (pid !== undefined && !this.isPidAlive(pid)) this.release(attachId);
    }
  }

  private cancel(tabId: string, attachId: string) {
    const set = this.cancelled.get(tabId) ?? new Set<string>();
    set.add(attachId);
    this.cancelled.set(tabId, set);
  }

  private liveTabs(): Array<TabRecord & { tabId: string }> {
    const cutoff = this.now() - TAB_TTL_MS;
    const live: Array<TabRecord & { tabId: string }> = [];
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

    for (const record of this.attaches.values()) {
      if (record.status === "claimed" && !liveIds.has(record.claimedBy!)) {
        // The tab that took it closed before finishing; another tab starts over.
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
      this.assignOne(record, signedIn, now, record.targetProjectId ?? record.decision?.projectId);
    }

    for (const [attachId, record] of this.releases) {
      const showing = signedIn.filter(
        (tab) => tab.project?.id === record.decision.projectId,
      );
      if (showing.length === 0) {
        // Only a tab showing the project can remove the entry. With none
        // open, the entry stays saved and the dev command's quit is a no-op.
        this.releases.delete(attachId);
        continue;
      }
      this.assignOne(record, showing, now, record.decision.projectId);
    }
  }

  private assignOne(
    record: Assignment,
    candidates: Array<TabRecord & { tabId: string }>,
    now: number,
    preferredProjectId: string | undefined,
  ) {
    if (record.tabId) {
      const stillLive = candidates.some((tab) => tab.tabId === record.tabId);
      const timedOut =
        record.deliveredAt !== undefined &&
        now - record.deliveredAt > CLAIM_TIMEOUT_MS;
      if (stillLive && !timedOut) return;
      if (timedOut) record.skipped.add(record.tabId);
      delete record.tabId;
      delete record.deliveredAt;
    }
    let pool = candidates.filter((tab) => !record.skipped.has(tab.tabId));
    if (pool.length === 0 && candidates.length > 0) {
      record.skipped.clear();
      pool = candidates;
    }
    const preferred = preferredProjectId
      ? pool.filter((tab) => tab.project?.id === preferredProjectId)
      : [];
    const choices = preferred.length > 0 ? preferred : pool;
    const best = choices.reduce<(TabRecord & { tabId: string }) | undefined>(
      (a, b) => (!a || b.focusedAt > a.focusedAt ? b : a),
      undefined,
    );
    if (best) record.tabId = best.tabId;
  }
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
