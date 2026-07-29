/**
 * Durable task tracker for MCP Tasks.
 *
 * Tasks are tracked locally because servers are not required to remember them:
 * legacy servers may forget them across sessions, and the extension wire has
 * no `tasks/list` at all — there the tracker IS the list. For anonymous and
 * local use it is the only copy; for authenticated users it is still the
 * immediate write path, with the hosted registry as a best-effort recovery
 * index behind it rather than a replacement.
 *
 * Identity is the composite `(scope, serverId, wire, taskId)`: task IDs are
 * only unique within a server, the same ID can exist on both wires while a
 * developer flips protocol versions, and hosted task IDs are bearer-ish
 * handles that must not leak between accounts or organizations sharing a
 * browser — hence the auth/org `scope` segment.
 *
 * ## What is stored, and what is deliberately not
 *
 * Enough to RESUME a task, and nothing more: the handle, its identity, its
 * latest scheduling hints, and which input keys have been answered. Never the
 * elicitation prompts, the sampling content, the roots, the responses, or the
 * task's result. A tracker entry is a bookmark, not a transcript.
 *
 * ## Why an entry is dropped
 *
 * Only ever for storage bounds — count, age, string length, serialized size —
 * and never from a TTL. `ttlMs` is the SERVER's licence to discard a task, not
 * ours (`tasks.md:136-140`), it may change over the task's lifetime
 * (`tasks.md:340`), and `null` means unlimited. So an elapsed TTL raises a
 * handle's poll priority and does nothing else. The age bound is measured and
 * documented as a localStorage cap, not as an expiry.
 */

import { TRACKED_TASK_MAX_AGE_MS } from "@/shared/hosted-tasks";
import type { TasksWire } from "./apis/mcp-tasks-api";

export type PrimitiveType = "tool" | "prompt" | "resource";

export interface TrackedTask {
  taskId: string;
  serverId: string;
  wire: TasksWire;
  createdAt: string;
  toolName?: string;
  primitiveType?: PrimitiveType;
  primitiveName?: string;
  dismissed?: boolean;
  /** Server no longer knows this task (JSON-RPC -32602 on a read). */
  expired?: boolean;
  /**
   * Auth/org context the handle was created under (hosted projectId).
   * Undefined for purely local entries, which have no cross-account risk.
   */
  scope?: string;

  // ---- v3: resumable scheduling state -------------------------------------
  /** Last `lastUpdatedAt` observed from the server. Never inferred locally. */
  lastUpdatedAt?: string;
  /** Latest observed status, so a reload can render before the first poll. */
  status?: string;
  /** Latest `ttlMs`. `null` means the server said "no expiry". */
  ttlMs?: number | null;
  /** Latest server-advertised poll floor. MAY change in either direction. */
  pollIntervalMs?: number;
  /** Epoch ms this handle may next be polled; survives a reload. */
  nextPollAt?: number;
  /** Epoch ms a live read last answered for this handle, any status. */
  lastObservedAt?: number;
  /**
   * Input keys whose `tasks/update` was acknowledged. KEYS ONLY — never the
   * request, the prompt, or the response. This is what stops a reload from
   * re-prompting for something the user already answered.
   */
  respondedInputKeys?: string[];
}

/**
 * Current auth/org context. Set from the API context so a logout or an
 * organization switch immediately hides — and on the next write drops —
 * handles belonging to the previous actor.
 */
let activeScope: string | undefined;

export function setTrackedTaskScope(scope: string | null | undefined): void {
  activeScope = scope ?? undefined;
}

export function getTrackedTaskScope(): string | undefined {
  return activeScope;
}

function inScope(task: TrackedTask): boolean {
  return (task.scope ?? undefined) === activeScope;
}

const STORAGE_KEY = "mcp-tracked-tasks";
/**
 * v1: bare array, no wire tag. v2: `{version, tasks}` with `wire`.
 * v3: adds resumable scheduling state and responded input keys.
 */
const SCHEMA_VERSION = 3;
const MAX_TRACKED_TASKS = 50;

/** Bounds on untrusted, server-influenced strings before they are persisted. */
const MAX_STRING_LENGTH = 1024;
const MAX_RESPONDED_KEYS = 100;
/** Whole-payload ceiling; entries are shed oldest-first until it is met. */
const MAX_SERIALIZED_BYTES = 512 * 1024;

interface StoredShape {
  version: number;
  tasks: TrackedTask[];
}

export function taskIdentity(task: {
  serverId: string;
  wire: TasksWire;
  taskId: string;
  scope?: string;
}): string {
  return [task.scope ?? "", task.serverId, task.wire, task.taskId].join(
    "\u0000"
  );
}

function isFresh(task: TrackedTask, now: number): boolean {
  const createdAt = Date.parse(task.createdAt);
  // An unparseable timestamp is kept: dropping a handle we can't date would
  // silently lose a task the user may still be waiting on.
  if (Number.isNaN(createdAt)) return true;
  return now - createdAt < TRACKED_TASK_MAX_AGE_MS;
}

function clampString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > MAX_STRING_LENGTH
    ? value.slice(0, MAX_STRING_LENGTH)
    : value;
}

/**
 * An IDENTITY string: over-length is rejected, never truncated.
 *
 * `taskId`, `serverId` and `scope` are the three components of
 * {@link taskIdentity}, so truncating one does not shorten a value — it
 * silently produces a DIFFERENT handle than the one that was written, and any
 * two values sharing a 1024-character prefix collapse into a single identity
 * that shares `respondedInputKeys` and `nextPollAt`. For `scope` — the
 * auth/org segment that keeps one account's handles out of another's — that
 * collapse is a cross-account leak rather than a display glitch.
 *
 * Dropping the record instead costs a handle the user can re-create; the
 * bounds still hold, because a rejected record is not persisted at all.
 */
function identityString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // NUL is REJECTED, not stripped or escaped. It is the delimiter the composite
  // identity key is joined with, so a component containing one re-parses as a
  // different split: `serverId: "a\u0000b"` with `taskId: "c"` produces the same
  // key as `serverId: "a"` with `taskId: "b\u0000c"`. Two distinct handles would
  // then share one record — inheriting each other's `nextPollAt` and, worse,
  // each other's answered-input keys, so a prompt one of them never answered
  // would be silently skipped.
  return value.length > MAX_STRING_LENGTH || value.includes("\u0000")
    ? undefined
    : value;
}

function clampNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Normalizes one stored record. Anything unrecognized is dropped rather than
 * trusted: this data is attacker-influenceable (a server picks the task id and
 * the input keys) and it is read on every page load.
 */
function sanitize(raw: unknown): TrackedTask | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const taskId = identityString(record.taskId);
  const serverId = identityString(record.serverId);
  const createdAt = clampString(record.createdAt);
  if (!taskId || !serverId) return undefined;
  // Present but over-length. `identityString` cannot distinguish that from
  // absent, and the two are not the same: an absent scope is the default
  // scope, while an over-length one is a scope we cannot represent — reading
  // it as "default" would file another account's handle under this one.
  const scope = identityString(record.scope);
  if (record.scope !== undefined && scope === undefined) return undefined;
  // Reject rather than default to `""`. Every other unrecognized field here is
  // dropped; defaulting this one would produce a string no date parser
  // accepts, and `isFresh` and the Tasks tab's sort comparator both call
  // `new Date(createdAt).getTime()` — so the record would contribute `NaN` to
  // an age check and to a comparator, giving an arbitrary ordering rather than
  // an error.
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) return undefined;

  // A stored entry without a wire tag predates the extension; defaulting keeps
  // `wire` non-optional at runtime (identity depends on it).
  const wire: TasksWire =
    record.wire === "extension" || record.wire === "legacy"
      ? record.wire
      : "legacy";

  const ttlMs = record.ttlMs === null ? null : clampNumber(record.ttlMs);
  const respondedInputKeys = Array.isArray(record.respondedInputKeys)
    ? record.respondedInputKeys
        .filter((key): key is string => typeof key === "string")
        .slice(0, MAX_RESPONDED_KEYS)
        .map((key) => key.slice(0, MAX_STRING_LENGTH))
    : undefined;

  const task: TrackedTask = {
    taskId,
    serverId,
    wire,
    createdAt,
    ...(clampString(record.toolName)
      ? { toolName: clampString(record.toolName) }
      : {}),
    ...(record.primitiveType === "tool" ||
    record.primitiveType === "prompt" ||
    record.primitiveType === "resource"
      ? { primitiveType: record.primitiveType }
      : {}),
    ...(clampString(record.primitiveName)
      ? { primitiveName: clampString(record.primitiveName) }
      : {}),
    ...(record.dismissed === true ? { dismissed: true } : {}),
    ...(record.expired === true ? { expired: true } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(clampString(record.lastUpdatedAt)
      ? { lastUpdatedAt: clampString(record.lastUpdatedAt) }
      : {}),
    ...(clampString(record.status)
      ? { status: clampString(record.status) }
      : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(clampNumber(record.pollIntervalMs) !== undefined
      ? { pollIntervalMs: clampNumber(record.pollIntervalMs) }
      : {}),
    ...(clampNumber(record.nextPollAt) !== undefined
      ? { nextPollAt: clampNumber(record.nextPollAt) }
      : {}),
    ...(clampNumber(record.lastObservedAt) !== undefined
      ? { lastObservedAt: clampNumber(record.lastObservedAt) }
      : {}),
    ...(respondedInputKeys?.length ? { respondedInputKeys } : {}),
  };
  return task;
}

/**
 * v1 → v3 and v2 → v3 are both pure widenings: every added field is optional,
 * so an older record is already a valid v3 record once its `wire` is defaulted.
 *
 * A FUTURE version is ignored entirely rather than best-effort parsed. A newer
 * tab may have written fields whose meaning we would get wrong, and a wrong
 * `nextPollAt` or a wrongly-inherited `respondedInputKeys` is worse than
 * re-deriving both from the server.
 */
function migrate(parsed: unknown): TrackedTask[] {
  // v1 stored a bare array with no wire tag; those entries predate the
  // extension, so they are legacy by construction.
  if (Array.isArray(parsed)) {
    return parsed
      .map(sanitize)
      .filter((task): task is TrackedTask => task !== undefined);
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const stored = parsed as Partial<StoredShape>;
  if (typeof stored.version === "number" && stored.version > SCHEMA_VERSION) {
    return [];
  }
  if (!Array.isArray(stored.tasks)) return [];
  return stored.tasks
    .map(sanitize)
    .filter((task): task is TrackedTask => task !== undefined);
}

/** Every entry on disk, regardless of scope — writes must not drop other actors' handles. */
function loadAllTasks(): TrackedTask[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    const now = Date.now();
    return migrate(JSON.parse(data)).filter((task) => isFresh(task, now));
  } catch {
    // Corrupt JSON is indistinguishable from a hostile write; start clean
    // rather than throwing on every page load.
    return [];
  }
}

function loadTasks(): TrackedTask[] {
  return loadAllTasks().filter(inScope);
}

/**
 * Persists the in-scope entries while preserving other actors' entries.
 *
 * Current scope FIRST, and the order is load-bearing rather than cosmetic.
 * `saveTasks` sheds from the tail to fit the size ceiling, and `trackTask`
 * unshifts, so the prefix is "newest, mine" and the tail is "oldest, someone
 * else's". Concatenating the other way — which is what this did — put every
 * preserved handle from a previous account or organization scope ahead of the
 * current one, so a task created seconds ago was among the first records
 * dropped while stale handles belonging to a scope nobody is looking at
 * survived. Losing the handle the user is actively waiting on is the worst
 * outcome this store has.
 */
function saveInScope(next: TrackedTask[]): void {
  saveTasks([...next, ...loadAllTasks().filter((t) => !inScope(t))]);
}

function saveTasks(tasks: TrackedTask[]): void {
  try {
    let payload = tasks;
    let serialized = JSON.stringify({
      version: SCHEMA_VERSION,
      tasks: payload,
    } satisfies StoredShape);
    // Shed from the tail until the payload fits. `saveInScope` orders the
    // payload so the tail is the most expendable thing in the store — other
    // scopes' entries, then this scope's oldest — and a quota rejection would
    // otherwise lose the WHOLE store, including the handle the user is
    // actively waiting on.
    while (serialized.length > MAX_SERIALIZED_BYTES && payload.length > 1) {
      payload = payload.slice(0, Math.floor(payload.length / 2));
      serialized = JSON.stringify({
        version: SCHEMA_VERSION,
        tasks: payload,
      } satisfies StoredShape);
    }
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // localStorage might be full or unavailable
  }
}

export function getTrackedTasks(): TrackedTask[] {
  return loadTasks();
}

export function getTrackedTasksForServer(
  serverId: string,
  wire?: TasksWire
): TrackedTask[] {
  return loadTasks().filter(
    (t) =>
      t.serverId === serverId &&
      !t.dismissed &&
      (wire === undefined || t.wire === wire)
  );
}

export function getTrackedTaskById(
  taskId: string,
  serverId?: string
): TrackedTask | undefined {
  return loadTasks().find(
    (t) =>
      t.taskId === taskId && (serverId === undefined || t.serverId === serverId)
  );
}

export function trackTask(task: Omit<TrackedTask, "dismissed">): void {
  const scoped = { ...task, scope: task.scope ?? activeScope };
  // Same identity bound as the read path, applied HERE so an over-length
  // server-chosen id is refused at the door. Writing it and rejecting it on
  // the next `loadTasks` would make the handle vanish at the next reload with
  // nothing to explain why.
  if (
    identityString(scoped.taskId) === undefined ||
    identityString(scoped.serverId) === undefined ||
    (scoped.scope !== undefined && identityString(scoped.scope) === undefined)
  ) {
    return;
  }
  // Dedupe against EVERY scope on disk, not just the active slice. A caller
  // may pass an explicit `scope` captured at turn start that is no longer the
  // active scope (the user switched projects mid-stream); deduping only
  // against `loadTasks()` would let such a foreign-scope write duplicate an
  // identical entry that already exists under its own scope.
  const all = loadAllTasks();
  const identity = taskIdentity(scoped);
  if (all.some((t) => taskIdentity(t) === identity)) return;

  // The cap and its eviction operate on the DESTINATION scope's slice —
  // `scoped.scope`, which can differ from the active scope when the caller
  // passes a scope captured at turn start and the part arrives after a
  // project switch. Selecting by the ACTIVE scope here (the pre-fix
  // behavior) made a delayed project-A write evict project B's oldest
  // handle while leaving A's own slice uncapped — and an evicted
  // extension-wire handle is locally unrecoverable (no `tasks/list`).
  const inDestinationScope = (t: TrackedTask) =>
    (t.scope ?? undefined) === (scoped.scope ?? undefined);
  const destination = all.filter(inDestinationScope);
  destination.unshift({ ...scoped, dismissed: false });

  // Destination slice first (newest-first), every other scope's entries
  // behind it: the new entry is the newest handle in the store, exactly what
  // the tail-shedding in `saveTasks` must drop last. Other scopes' entries
  // are preserved, never capped, by a write that isn't theirs.
  saveTasks([
    ...destination.slice(0, MAX_TRACKED_TASKS),
    ...all.filter((t) => !inDestinationScope(t)),
  ]);
}

/**
 * Folds an observation into a tracked handle so a reload resumes where the
 * poller left off rather than restarting every task at its floor.
 *
 * A no-op for an untracked handle: this must never resurrect an entry the user
 * cleared or that belongs to another actor.
 */
/**
 * Applies one observation to a loaded entry. Shared by the single and batch
 * write paths so their field semantics — notably `null` `ttlMs` meaning "no
 * expiry" and therefore overwriting a number — cannot drift apart.
 */
function applyObservation(
  entry: TrackedTask,
  observation: TaskObservationPatch
): void {
  if (observation.status !== undefined) entry.status = observation.status;
  if (observation.lastUpdatedAt !== undefined) {
    entry.lastUpdatedAt = observation.lastUpdatedAt;
  }
  // `null` is meaningful (no expiry) and must overwrite a previous number, so
  // this checks for `undefined` rather than truthiness.
  if (observation.ttlMs !== undefined) entry.ttlMs = observation.ttlMs;
  if (observation.pollIntervalMs !== undefined) {
    entry.pollIntervalMs = observation.pollIntervalMs;
  }
  if (observation.nextPollAt !== undefined) {
    entry.nextPollAt = observation.nextPollAt;
  }
  if (observation.lastObservedAt !== undefined) {
    entry.lastObservedAt = observation.lastObservedAt;
  }
}

export interface TaskObservationPatch {
  status?: string;
  lastUpdatedAt?: string;
  ttlMs?: number | null;
  pollIntervalMs?: number;
  nextPollAt?: number;
  lastObservedAt?: number;
}

export interface TaskIdentityRef {
  taskId: string;
  serverId: string;
  wire: TasksWire;
  scope?: string;
}

/**
 * Batch form of {@link recordTaskObservation}.
 *
 * A poll tick observes every due handle, and the single-entry function parses
 * and re-serializes the whole store per call — so N due handles cost 2N full
 * parses and N serializations on the main thread, every interval. This makes
 * the cost per TICK instead of per task, which also narrows the window in
 * which two tabs polling the same server clobber each other's hints.
 */
export function recordTaskObservations(
  entries: readonly {
    identity: TaskIdentityRef;
    observation: TaskObservationPatch;
  }[]
): void {
  if (entries.length === 0) return;
  const tasks = loadTasks();
  const byKey = new Map(tasks.map((task) => [taskIdentity(task), task]));
  let changed = false;
  for (const { identity, observation } of entries) {
    const entry = byKey.get(
      taskIdentity({ ...identity, scope: identity.scope ?? activeScope })
    );
    // Never resurrects an untracked handle: this must not recreate an entry
    // the user cleared or that belongs to another actor.
    if (!entry) continue;
    applyObservation(entry, observation);
    changed = true;
  }
  if (changed) saveInScope(tasks);
}

/** Everything the lifecycle engine needs to restore one handle after a reload. */
export interface TrackedTaskRestoreState {
  nextPollAt?: number;
  lastObservedAt?: number;
  pollIntervalMs?: number;
  ttlMs?: number | null;
  status?: string;
  respondedInputKeys: string[];
}

/**
 * Batch form of {@link getTrackedTaskSchedule} + {@link getRespondedInputKeys}.
 *
 * Seeding the engine used to cost TWO full `loadTasks()` parses per newly-seen
 * handle — so the first tick after a reload, when every tracked handle is
 * newly seen, ran 2N parse-and-migrate passes over the whole store on the main
 * thread. That is the same per-task cost {@link recordTaskObservations} exists
 * to avoid on the write side; this is the read side of it. One parse per tick.
 *
 * Keyed by `taskIdentity(identity)` of the identity AS PASSED — not by the
 * scope-defaulted key used to match rows — so a caller that omitted `scope`
 * (meaning "the active scope") can look its own result up without having to
 * know what the active scope is.
 */
export function getTrackedTaskRestoreStates(
  identities: readonly TaskIdentityRef[]
): Map<string, TrackedTaskRestoreState> {
  const result = new Map<string, TrackedTaskRestoreState>();
  if (identities.length === 0) return result;
  const callerKeyByStoredKey = new Map<string, string>();
  for (const identity of identities) {
    callerKeyByStoredKey.set(
      taskIdentity({ ...identity, scope: identity.scope ?? activeScope }),
      taskIdentity(identity)
    );
  }
  for (const entry of loadTasks()) {
    const callerKey = callerKeyByStoredKey.get(taskIdentity(entry));
    if (callerKey === undefined) continue;
    result.set(callerKey, {
      nextPollAt: entry.nextPollAt,
      lastObservedAt: entry.lastObservedAt,
      pollIntervalMs: entry.pollIntervalMs,
      ttlMs: entry.ttlMs,
      status: entry.status,
      respondedInputKeys: entry.respondedInputKeys ?? [],
    });
  }
  return result;
}

/**
 * The persisted scheduling state for a handle, for seeding the lifecycle
 * engine after a reload. `undefined` when the handle is not tracked.
 */
export function getTrackedTaskSchedule(identity: TaskIdentityRef):
  | {
      nextPollAt?: number;
      lastObservedAt?: number;
      pollIntervalMs?: number;
      ttlMs?: number | null;
      status?: string;
    }
  | undefined {
  const key = taskIdentity({
    ...identity,
    scope: identity.scope ?? activeScope,
  });
  const entry = loadTasks().find((task) => taskIdentity(task) === key);
  if (!entry) return undefined;
  return {
    nextPollAt: entry.nextPollAt,
    lastObservedAt: entry.lastObservedAt,
    pollIntervalMs: entry.pollIntervalMs,
    ttlMs: entry.ttlMs,
    status: entry.status,
  };
}

export function recordTaskObservation(
  identity: {
    taskId: string;
    serverId: string;
    wire: TasksWire;
    scope?: string;
  },
  observation: {
    status?: string;
    lastUpdatedAt?: string;
    ttlMs?: number | null;
    pollIntervalMs?: number;
    nextPollAt?: number;
    lastObservedAt?: number;
  }
): void {
  const scoped = { ...identity, scope: identity.scope ?? activeScope };
  const key = taskIdentity(scoped);
  const tasks = loadTasks();
  const entry = tasks.find((t) => taskIdentity(t) === key);
  if (!entry) return;

  applyObservation(entry, observation);
  saveInScope(tasks);
}

/**
 * Marks input keys answered, after the `tasks/update` acknowledgement
 * succeeded. Keys only — the request and the response are never persisted.
 */
export function recordRespondedInputKeys(
  identity: {
    taskId: string;
    serverId: string;
    wire: TasksWire;
    scope?: string;
  },
  keys: readonly string[]
): void {
  if (keys.length === 0) return;
  const scoped = { ...identity, scope: identity.scope ?? activeScope };
  const key = taskIdentity(scoped);
  const tasks = loadTasks();
  const entry = tasks.find((t) => taskIdentity(t) === key);
  if (!entry) return;

  const merged = new Set([...(entry.respondedInputKeys ?? []), ...keys]);
  entry.respondedInputKeys = [...merged]
    .slice(0, MAX_RESPONDED_KEYS)
    .map((k) => k.slice(0, MAX_STRING_LENGTH));
  saveInScope(tasks);
}

export function getRespondedInputKeys(identity: {
  taskId: string;
  serverId: string;
  wire: TasksWire;
  scope?: string;
}): string[] {
  const scoped = { ...identity, scope: identity.scope ?? activeScope };
  const key = taskIdentity(scoped);
  return (
    loadTasks().find((t) => taskIdentity(t) === key)?.respondedInputKeys ?? []
  );
}

export function untrackTask(taskId: string, serverId?: string): void {
  saveInScope(
    loadTasks().filter(
      (t) =>
        !(
          t.taskId === taskId &&
          (serverId === undefined || t.serverId === serverId)
        )
    )
  );
}

export function markTaskExpired(taskId: string, serverId?: string): void {
  const tasks = loadTasks();
  for (const task of tasks) {
    if (
      task.taskId === taskId &&
      (serverId === undefined || task.serverId === serverId)
    ) {
      task.expired = true;
    }
  }
  saveInScope(tasks);
}

export function dismissTask(taskId: string, serverId?: string): void {
  const tasks = loadTasks();
  for (const task of tasks) {
    if (
      task.taskId === taskId &&
      (serverId === undefined || task.serverId === serverId)
    ) {
      task.dismissed = true;
    }
  }
  saveInScope(tasks);
}

export function dismissTasksForServer(
  serverId: string,
  taskIds: string[]
): void {
  const idsToDissmiss = new Set(taskIds);
  const tasks = loadTasks();
  for (const task of tasks) {
    if (task.serverId === serverId && idsToDissmiss.has(task.taskId)) {
      task.dismissed = true;
    }
  }
  saveInScope(tasks);
}

// ---------------------------------------------------------------------------
// Dismissed REGISTRY-ONLY handles.
//
// A handle recovered from the hosted registry has no tracker row (writing one
// would resurrect entries the user cleared and duplicate the registry's own
// persistence), so a tracker-row `dismissed` flag has nowhere to live. Their
// dismissals are a separate, bounded id set: a local VIEW preference on this
// browser only — the registry row itself is never deleted for it. Scoped like
// the tracker rows, because these ids are bearer-ish too.
// ---------------------------------------------------------------------------

const DISMISSED_REGISTRY_KEY = "mcp-dismissed-registry-tasks";
const MAX_DISMISSED_REGISTRY_IDS_PER_SERVER = 200;

function dismissedRegistryKey(serverId: string): string {
  return `${activeScope ?? ""}\u0000${serverId}`;
}

function loadDismissedRegistry(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(DISMISSED_REGISTRY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      out[key] = value
        .filter(
          (id): id is string =>
            typeof id === "string" &&
            id.length > 0 &&
            id.length <= MAX_STRING_LENGTH
        )
        .slice(0, MAX_DISMISSED_REGISTRY_IDS_PER_SERVER);
    }
    return out;
  } catch {
    return {};
  }
}

function saveDismissedRegistry(store: Record<string, string[]>): void {
  try {
    localStorage.setItem(DISMISSED_REGISTRY_KEY, JSON.stringify(store));
  } catch {
    // localStorage might be full or unavailable
  }
}

/**
 * Hides registry-recovered handles on THIS browser. The merge filter in the
 * Tasks tab consults {@link getDismissedTaskIds}, which unions these in, so a
 * dismissed recovered handle stays hidden across refetches without touching
 * the backend row (global removal is the delete route's job, uncalled in v1).
 */
export function dismissRegistryTasks(
  serverId: string,
  taskIds: readonly string[]
): void {
  const ids = taskIds.filter((id) => identityString(id) !== undefined);
  if (ids.length === 0) return;
  const store = loadDismissedRegistry();
  const key = dismissedRegistryKey(serverId);
  const merged = [...new Set([...(store[key] ?? []), ...ids])];
  // Keep the NEWEST dismissals when the bound trims: the oldest are the ones
  // most likely to have been pruned from the registry already.
  store[key] = merged.slice(-MAX_DISMISSED_REGISTRY_IDS_PER_SERVER);
  saveDismissedRegistry(store);
}

export function getDismissedTaskIds(serverId: string): Set<string> {
  const dismissed = new Set(
    loadTasks()
      .filter((t) => t.serverId === serverId && t.dismissed)
      .map((t) => t.taskId)
  );
  for (const id of loadDismissedRegistry()[dismissedRegistryKey(serverId)] ??
    []) {
    dismissed.add(id);
  }
  return dismissed;
}

export function clearTrackedTasksForServer(serverId: string): void {
  saveInScope(loadTasks().filter((t) => t.serverId !== serverId));
}

/**
 * Drops every handle for the previous actor. Called on logout / organization
 * switch: task IDs are bearer-ish and must not survive an actor change on a
 * shared browser.
 */
export function clearTrackedTasksForScope(
  scope: string | null | undefined
): void {
  const target = scope ?? undefined;
  saveTasks(loadAllTasks().filter((t) => (t.scope ?? undefined) !== target));
  // The dismissed-registry ids are bearer-ish task ids too, and must not
  // survive an actor change on a shared browser any more than the rows do.
  const store = loadDismissedRegistry();
  const prefix = `${target ?? ""}\u0000`;
  let changed = false;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) saveDismissedRegistry(store);
}

export function clearAllTrackedTasks(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(DISMISSED_REGISTRY_KEY);
  } catch {
    // Ignore errors
  }
}
