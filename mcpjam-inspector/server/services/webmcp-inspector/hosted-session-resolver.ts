/**
 * Finding a hosted session that this process may never have started.
 *
 * The hosted plane runs several replicas with no affinity, so the replica that
 * created a session is not the one that gets the next request for it. The V1
 * registry is a per-process `Map`, which means "session created on A, command
 * lands on B" is a 404 for a browser that is running perfectly well — and it
 * is not an edge case, it is what every other request does.
 *
 * The fix is to make the runtime RE-DERIVABLE rather than to pin traffic to a
 * replica. A hosted session id names its own inputs (`hosted:<project>:<box>`),
 * the durable half already lives in Convex (the `browserSessions` row records
 * the daemon's origin, token and boot id), so a replica that has never heard
 * of a session can work out what it refers to, attach to the daemon, and serve
 * the request. The person sees one continuous session; the fleet sees stateless
 * replicas.
 *
 * Three rules hold this together, and each one is a thing that must not happen:
 *
 *   NEVER RESERVE HERE. Reserving wakes a machine and starts billing it.
 *   Re-hydration is reached from `GET` and from an SSE subscribe — a tab left
 *   open overnight, a polling script — and provisioning from those would
 *   resurrect a computer its owner deliberately let sleep. Only the explicit
 *   start reserves; this attaches to what is already there, or refuses.
 *
 *   NEVER SERVE SOMEONE ELSE'S SESSION. A hosted id is derived, so it is
 *   guessable, unlike the random ids V1 issued. Ownership is proven by asking
 *   the control plane with the CALLER's bearer: a computer that is not theirs
 *   answers with a different id (or none), and the mismatch is a 404.
 *
 *   NEVER SERVE AN EMPTY TOOL MAP. Invocations resolve their `toolKey` against
 *   the runtime's own tool list at dequeue. A freshly re-hydrated runtime has
 *   none until its first poll returns, so a command arriving in that window
 *   would be told the page no longer offers a tool the user is looking at on
 *   their screen. The first snapshot is therefore awaited BEFORE the runtime is
 *   registered.
 */
import {
  attachBrowserSession,
  type HostedBrowserSessionHandle,
} from "../browserd/browser-session.js";
import { liveBrowserSessionDeps } from "../browserd/live-session-deps.js";
import { convexGetDesktopComputerStatus } from "../../utils/computers/convex-environment-client.js";
import { createBrowserdWebMcpProvider } from "./browserd-provider.js";
import { WebMcpSessionRuntime } from "./session-runtime.js";
import {
  parseHostedSessionId,
  WebMcpSessionNotFoundError,
  type WebMcpSessionRegistry,
} from "./session-registry.js";

/**
 * The computer exists and is theirs, but there is no daemon to talk to.
 *
 * Distinct from "not yours", which is a 404. What it says depends on WHY, and
 * that distinction is the whole point of the type: a machine that is asleep
 * needs the person to start it, one that is still provisioning needs them to
 * wait, and one that has been deleted needs them to make a new one. Telling
 * somebody to "open the browser again to wake it" about a computer that is
 * mid-deletion sends them to do something that cannot work.
 */
export class HostedDesktopUnavailableError extends Error {
  readonly code: string;

  constructor(readonly status: string) {
    const { code, message } = describeUnavailable(status);
    super(message);
    this.code = code;
    this.name = "HostedDesktopUnavailableError";
  }
}

function describeUnavailable(status: string): {
  code: string;
  message: string;
} {
  switch (status) {
    // `requested` is the FIRST thing the control plane reports, before
    // provisioning has visibly begun. Reading it as "asleep" tells somebody to
    // start a machine that is already starting.
    case "requested":
    case "provisioning":
    case "starting":
      return {
        code: "hosted-desktop-starting",
        message:
          "Your computer is still starting. Give it a moment and open the browser again.",
      };
    case "deleting":
    case "deleted":
      return {
        code: "hosted-desktop-deleted",
        message:
          "That computer has been deleted. Open the browser again to get a new one.",
      };
    case "error":
    case "errored":
    case "failed":
      return {
        code: "hosted-desktop-errored",
        message:
          "Your computer stopped with an error and cannot be reached. Open the browser again to start a new one.",
      };
    default:
      // Hibernating, stopped, paused — and anything a newer control plane
      // invents. All of them mean the same thing to the person, and the
      // default is the one that is safe to be wrong about: it asks them to
      // start it, rather than telling them it is gone.
      return {
        code: "hosted-desktop-asleep",
        message:
          "Your computer is asleep. Open the browser again to wake it — this page will not wake it for you, because waking starts billing.",
      };
  }
}

/**
 * Statuses a daemon can actually be reached on. `waking` is included: the box
 * is coming up under its own steam and the attach below will wait for it.
 * Everything else — hibernating, provisioning, deleting, errored — has no
 * daemon to talk to, and only an explicit start should change that.
 */
const LIVE_STATUSES = new Set(["ready", "waking"]);

/**
 * How long a proved access claim is trusted before it is proved again.
 *
 * A ceiling on how long somebody keeps a browser they have lost access to, and
 * a floor under how often this path costs a control-plane round trip. One
 * minute, the same figure and the same reasoning as the activity touch.
 */
export const ACCESS_RECHECK_MS = 60_000;

const accessCheckedAt = new Map<string, number>();
/** Rechecks currently in flight, by session. See the call site. */
const accessInFlight = new Map<string, Promise<void>>();

/**
 * How many sessions this replica remembers having checked.
 *
 * Bounded for the same reason the activity throttle is: an entry per distinct
 * hosted session id, removed only on refusal, so a long-lived replica keeps
 * one for every computer it ever served. Eviction only ever takes entries
 * already PAST their window — dropping a live one would let a rotating set of
 * ids skip the check, which is the one thing this must not do. If nothing has
 * expired the new session is simply not recorded, so it is rechecked next
 * time: more round trips, never fewer checks.
 */
const MAX_TRACKED_SESSIONS = 4_096;

function shouldRecheckAccess(sessionId: string, now: number): boolean {
  const previous = accessCheckedAt.get(sessionId);
  // `undefined` kept distinct from a recorded 0, as in `activity-touch`: a
  // session nobody has checked must always be checked, and coalescing to 0
  // makes that false for any `now` inside the window of the epoch. The gap is
  // ABSOLUTE so a clock stepping backwards cannot suppress checks either.
  if (previous !== undefined && Math.abs(now - previous) < ACCESS_RECHECK_MS) {
    return false;
  }
  if (accessCheckedAt.size >= MAX_TRACKED_SESSIONS) {
    for (const [id, at] of accessCheckedAt) {
      if (Math.abs(now - at) >= ACCESS_RECHECK_MS) accessCheckedAt.delete(id);
    }
    if (accessCheckedAt.size >= MAX_TRACKED_SESSIONS) return true;
  }
  accessCheckedAt.set(sessionId, now);
  return true;
}

function forgetAccess(sessionId: string): void {
  accessCheckedAt.delete(sessionId);
}

export function resetAccessRecheckForTests(): void {
  accessCheckedAt.clear();
  accessInFlight.clear();
}

/**
 * Record that access to this session was just proved by other means.
 *
 * The replica that CREATES a session proved it by reserving the computer with
 * the caller's own bearer, which is a stronger check than the one above. Saying
 * so here stops the very next command paying for a round trip to establish what
 * the request before it already established.
 */
export function noteAccessProved(
  sessionId: string,
  now: number = Date.now(),
): void {
  accessCheckedAt.set(sessionId, now);
}

export interface HostedResolveDeps {
  statusOf?: typeof convexGetDesktopComputerStatus;
  /** Test seam for the re-check throttle. */
  now?: () => number;
  attach?: (args: {
    computerId: string;
  }) => Promise<HostedBrowserSessionHandle>;
  /** Poll cadence for a re-hydrated runtime; 0 disables (tests). */
  toolPollMs?: number;
  onCommand?: (info: { computerId: string; sessionId: string }) => void;
  hasWatchers?: (sessionId: string) => boolean;
}

export interface HostedResolveArgs {
  sessionId: string;
  bearer: string;
  /** The verified caller; the re-hydrated runtime is bound to them. */
  ownerId: string;
  registry: WebMcpSessionRegistry;
  deps?: HostedResolveDeps;
}

/**
 * The runtime for a hosted session id: the live one if this replica has it,
 * otherwise a freshly adopted one.
 *
 * Throws `WebMcpSessionNotFoundError` when the id does not name a computer
 * this caller owns, and `HostedDesktopAsleepError` when it does but the
 * machine is not up.
 */
export async function resolveHostedSession(
  args: HostedResolveArgs,
): Promise<WebMcpSessionRuntime> {
  const { sessionId, bearer, ownerId, registry } = args;
  const deps = args.deps ?? {};

  const parsed = parseHostedSessionId(sessionId);
  if (!parsed) {
    throw new WebMcpSessionNotFoundError(
      "That WebMCP session no longer exists. Open the page again to start a new one.",
    );
  }

  const statusOf = deps.statusOf ?? convexGetDesktopComputerStatus;
  const now = deps.now ?? Date.now;

  const existing = registry.peek(sessionId);
  if (existing) {
    if (!existing.belongsTo(ownerId)) {
      // 404, not 403: a 403 would confirm that this session exists and whose
      // it is, to anyone who can guess a project and computer id.
      throw new WebMcpSessionNotFoundError(
        "That WebMCP session no longer exists. Open the page again to start a new one.",
      );
    }
    // The owner check above is against the id recorded when the session was
    // CREATED, and access can be taken away after that. Left at just the id, a
    // person removed from a project keeps driving its browser until the
    // runtime is evicted — up to an hour, on a machine they are no longer
    // allowed near.
    //
    // Re-checked against the control plane, but THROTTLED: this path is every
    // command, every reconnect and every poll, and a round trip on each would
    // put a Convex query in front of a keystroke. Once a minute is the same
    // trade the activity touch makes, and it bounds the window rather than
    // leaving it open for the session's lifetime.
    // Awaited whether or not THIS request started it: a check already running
    // for this session is the answer for everyone waiting on it. Recording the
    // timestamp before awaiting is what makes the throttle cheap, and on its
    // own it is also a hole — a second request arriving mid-check sees a fresh
    // timestamp, skips the check, and is served from a runtime whose ownership
    // is at that moment being disproved.
    const running = accessInFlight.get(sessionId);
    if (running) {
      await running;
    } else if (shouldRecheckAccess(sessionId, now())) {
      const check = (async () => {
        // A THROWN lookup is not a refusal. The control plane being briefly
        // unreachable would otherwise tear down every live session on this
        // replica at once, which is a much worse failure than a minute of
        // access somebody has just lost — and the throttle bounds that minute.
        // A definite answer that the computer is not theirs IS a refusal.
        const status = await statusOf(bearer, parsed.projectId).catch(
          () => undefined,
        );
        // `undefined` means the lookup failed; `null` means a definite
        // "no such computer for this caller", which IS a refusal.
        if (status === undefined) return;
        if (!status || status.computerId !== parsed.computerId) {
          forgetAccess(sessionId);
          // Their handle on it goes too. Leaving the runtime registered would
          // keep its poll running against a machine this caller may no longer
          // reach, and would let the next request inside the throttle window
          // through on the strength of a check that has just failed.
          await registry
            .close(sessionId, { reason: "detached" })
            .catch(() => {});
          throw new WebMcpSessionNotFoundError(
            "That WebMCP session no longer exists. Open the page again to start a new one.",
          );
        }
        // Still theirs, but it may have gone to sleep, been deleted or failed
        // since this runtime was built. Serving the stale handle would queue
        // commands against a daemon that is not there.
        if (!LIVE_STATUSES.has(status.status)) {
          forgetAccess(sessionId);
          await registry
            .close(sessionId, { reason: "detached" })
            .catch(() => {});
          throw new HostedDesktopUnavailableError(status.status);
        }
      })();
      accessInFlight.set(sessionId, check);
      try {
        await check;
      } finally {
        accessInFlight.delete(sessionId);
      }
    }
    registry.touch(existing);
    return existing;
  }

  const status = await statusOf(bearer, parsed.projectId);
  // A computer id that does not match the one the caller actually owns for
  // this project is the whole ownership check: the control plane resolved it
  // from THEIR bearer, so a guessed id simply will not come back.
  if (!status || status.computerId !== parsed.computerId) {
    throw new WebMcpSessionNotFoundError(
      "That WebMCP session no longer exists. Open the page again to start a new one.",
    );
  }
  if (!LIVE_STATUSES.has(status.status)) {
    throw new HostedDesktopUnavailableError(status.status);
  }
  // This IS an access check, and a fresh one. Recording it means the request
  // that immediately follows a re-hydration — the client's own reconnect,
  // typically — does not pay for a second round trip to prove the same thing.
  shouldRecheckAccess(sessionId, now());

  const attach =
    deps.attach ??
    ((attachArgs: { computerId: string }) =>
      attachBrowserSession(liveBrowserSessionDeps(), attachArgs));
  const handle = await attach({ computerId: parsed.computerId });

  const runtime = new WebMcpSessionRuntime("about:blank", {
    sessionId,
    ownerId,
    // Adopting, not starting: no second "session started" in a timeline that
    // already has one.
    rehydrated: true,
    now: () => registry.clock(),
    onActivity: () => registry.touch(runtime),
  });
  const provider = createBrowserdWebMcpProvider({
    handle,
    ...(deps.toolPollMs !== undefined ? { toolPollMs: deps.toolPollMs } : {}),
    ...(deps.onCommand ? { onCommand: deps.onCommand } : {}),
    ...(deps.hasWatchers
      ? { hasWatchers: () => deps.hasWatchers!(sessionId) }
      : {}),
  });

  const session = await provider.createSession({
    url: "about:blank",
    // Read where the browser is; do not send it anywhere. Someone may be
    // mid-checkout on that page.
    navigate: false,
    callbacks: runtime.callbacks(),
  });
  runtime.attach(session);
  try {
    // `createSession` already awaited one tool snapshot through
    // `navigate:false`, so the map is populated before anything can be
    // invoked against it.
    registry.register(runtime);
  } catch (error) {
    // Registration can refuse — the hosted cap is full, or the process is
    // shutting down. The session is already ATTACHED by then, with a poll
    // timer running against the daemon, and nothing else holds a reference to
    // it: left alone it observes forever on behalf of a runtime no request
    // can ever reach. Dropping the handle does not touch the member's
    // browser, which is what `detached` says.
    await runtime.close("detached").catch(() => {});
    throw error;
  }
  return runtime;
}
