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
  type BrowserSessionHandle,
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

/** The computer is there, but not awake. Distinct from "not yours". */
export class HostedDesktopAsleepError extends Error {
  constructor(readonly status: string) {
    super(
      "Your computer is asleep. Open the browser again to wake it — this page will not wake it for you, because waking starts billing.",
    );
    this.name = "HostedDesktopAsleepError";
  }
}

/**
 * Statuses a daemon can actually be reached on. `waking` is included: the box
 * is coming up under its own steam and the attach below will wait for it.
 * Everything else — hibernating, provisioning, deleting, errored — has no
 * daemon to talk to, and only an explicit start should change that.
 */
const LIVE_STATUSES = new Set(["ready", "waking"]);

export interface HostedResolveDeps {
  statusOf?: typeof convexGetDesktopComputerStatus;
  attach?: (args: { computerId: string }) => Promise<BrowserSessionHandle>;
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

  const existing = registry.peek(sessionId);
  if (existing) {
    if (!existing.belongsTo(ownerId)) {
      // 404, not 403: a 403 would confirm that this session exists and whose
      // it is, to anyone who can guess a project and computer id.
      throw new WebMcpSessionNotFoundError(
        "That WebMCP session no longer exists. Open the page again to start a new one.",
      );
    }
    registry.touch(existing);
    return existing;
  }

  const parsed = parseHostedSessionId(sessionId);
  if (!parsed) {
    throw new WebMcpSessionNotFoundError(
      "That WebMCP session no longer exists. Open the page again to start a new one.",
    );
  }

  const statusOf = deps.statusOf ?? convexGetDesktopComputerStatus;
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
    throw new HostedDesktopAsleepError(status.status);
  }

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
  // `createSession` already awaited one tool snapshot through `navigate:false`,
  // so the map is populated before anything can be invoked against it.
  registry.register(runtime);
  return runtime;
}
