import type {
  ComputerBrowserSessionRecordArgs,
  SandboxBrowserSessionRecordArgs,
} from "./browser-sessions-client.js";
/**
 * Durable browser sessions (W2): ensure a live browserd daemon on a desktop
 * computer, replica-independently.
 *
 * The happy path never touches the sandbox: reserve → look up the session row
 * → verify the daemon itself over its authenticated `/v1/status` (liveness +
 * bootId + bearer in one probe) → reuse. Only when the row is missing, stale,
 * or the daemon fails verification does this connect to the sandbox and
 * relaunch: kill any leftover daemon, upload the bundle, boot, ensure the
 * auth-required stream (whose password the stream mints and holds only in
 * memory), and RECORD the result — the record is load-bearing, because the
 * stream password exists nowhere else durable and an unrecorded runtime is
 * one no replica can later find (record failure ⇒ stop the daemon and
 * refuse).
 *
 * Recovery posture is health-check, NOT kill-on-wake: a paused→resumed box
 * keeps its process tree, so a healthy daemon with the recorded bootId is
 * reused as-is and in-flight command idempotency survives.
 *
 * This is orchestration ONLY, in the same injected-seam form as
 * `browser-debug-probe.ts`: every live piece (Convex reserve/sandbox-info,
 * `Sandbox.connect`, the stream bootstrap, the session store) arrives via
 * `BrowserSessionDeps`, so the sequence — and every refusal path — is
 * unit-testable without E2B or the network. The live construction lives in
 * `live-session-deps.ts` (VALIDATE-ON-STAGING).
 */
import { randomUUID } from "node:crypto";
import { logger } from "../../utils/logger.js";
import type {
  BootBrowserdOptions,
  BrowserdHandle,
  BrowserdSandbox,
} from "./boot-browserd";
import type {
  BrowserdRecordArgs,
  BrowserdRecordResult,
  BrowserdRecordState,
  BrowserdCommandResponse,
  BrowserdLeaseState,
  BrowserdStatus,
} from "./browserd-client";
import {
  BROWSERD_PROTOCOL_VERSION,
  formatBrowserdError,
  HOSTED_DISPLAY,
  type BrowserCommand,
} from "./protocol";
import type {
  BrowserContextMode,
  BrowserRelaunchClaim,
  BrowserSessionLookup,
  BrowserSessionTargetArgs,
  BrowserSessionRecordResult,
  ComputerBrowserSessionLookup,
  ComputerBrowserSessionRecord,
  SandboxBrowserSessionLookup,
  SandboxBrowserSessionRecord,
} from "./browser-sessions-client";
import { withKeyedLock } from "./probe-lock";
// The same once-a-minute throttle the panel and the page tools use, so one
// computer is never told it is busy by three callers in the same minute.
import {
  shouldTouchActivity,
  shouldTouchSessionCommand,
} from "../../utils/computers/activity-touch.js";
import type { BrowserSessionService } from "./session-service.js";

/** Where the daemon lives inside the sandbox — the probe's proven recipe. */
export const BROWSERD_SCRIPT_PATH = "/opt/mcpjam/mcpjam-browserd.mjs";
export const BROWSERD_PORT = 8791;
export const BROWSERD_USER_DATA_DIR = "/home/user/.mcpjam-browserd";
/**
 * Where a PRELAUNCHED daemon leaves the bearer it minted for itself.
 *
 * A daemon baked into the desktop image starts before any inspector exists, so
 * nobody can hand it a secret. It mints 32 random bytes into this file at 0600
 * and the inspector reads them back over the E2B files API — the same
 * API-key-authenticated channel that already writes the daemon's own bytes, so
 * adopting one creates no trust relationship that did not already exist. The
 * agent's shell runs on a different box (`runtimeKind`), so nothing the model
 * drives can read it.
 */
export const BROWSERD_TOKEN_FILE = "/home/user/.mcpjam-browserd.token";
/** One-shot path used to import a saved profile before browserd launches. */
export const BROWSERD_PROFILE_ARCHIVE_PATH =
  "/tmp/mcpjam-browser-profile.tar.gz";

/**
 * A `BrowserdClient`, narrowed to what sessions need (fakeable in tests).
 *
 * The lease pair is OPTIONAL rather than required because the narrow shape
 * predates the pane: the hosted session path only ever needed to probe and
 * send. Both real clients implement all four, and the surfaces that hand a
 * person the browser (the rail, the panel) require them; a fake that only
 * needs `sendCommand` still satisfies this.
 */
export interface SessionClient {
  status(options?: { signal?: AbortSignal }): Promise<BrowserdStatus>;
  sendCommand(
    command: BrowserCommand,
    expectedBootId?: string,
  ): Promise<BrowserdCommandResponse>;
  /**
   * Read the lease. The signal is what lets the handoff poll be cancelled;
   * an implementation free to ignore it, but never to drop it silently.
   */
  lease?(options?: { signal?: AbortSignal }): Promise<BrowserdLeaseState>;
  leaseAction?(args: {
    action: "acquire" | "heartbeat" | "resume";
    holder: string;
    ttlMs?: number;
    kind?: "human" | "script";
  }): Promise<{ took: boolean; lease: BrowserdLeaseState }>;
  /**
   * Start or stop the daemon's recording of the display.
   *
   * Optional like the lease pair above: a client that only sends commands is
   * still a `SessionClient`, and a daemon that never advertised `"record"` is
   * never asked. Never throws for a refusal — a box with no ffmpeg is an
   * ordinary answer, not a failure of the run.
   */
  record?(args: BrowserdRecordArgs): Promise<BrowserdRecordResult>;
  recordStatus?(): Promise<BrowserdRecordState>;
  /** Export the persistent profile after the daemon queue has drained. */
  exportProfile?(): Promise<Uint8Array>;
}

/** The sandbox pieces the ensure path needs, once connected. */
export interface SessionSandbox {
  /** Write the daemon bundle into the sandbox filesystem. */
  writeBundle(path: string, content: Uint8Array): Promise<void>;
  /**
   * Read a small text file, for the prelaunched daemon's token.
   *
   * OPTIONAL: an older adapter, or a test fake with no filesystem in mind,
   * simply has none — and every way of failing to read means the same thing,
   * which is "boot a daemon yourself".
   */
  readTextFile?(path: string): Promise<string | undefined>;
  /**
   * Read a binary file — a recording — out of the sandbox.
   *
   * OPTIONAL for the same reason `readTextFile` is, and THROWING unlike it: a
   * missing token means "boot a daemon yourself" and a missing recording means
   * a run has lost its evidence, which the collector must be able to tell
   * apart from a run that was never recorded.
   */
  readBinaryFile?(path: string): Promise<Uint8Array>;
  /** The daemon runner `bootBrowserd` drives. */
  browserd: BrowserdSandbox;
  /** Reap any daemon from a previous boot (idempotent; never throws for
   *  "nothing to kill"). Runs before every relaunch so the fixed port and
   *  profile are free. */
  killBrowserd(): Promise<void>;
  /**
   * Ensure the live desktop stream is up with auth required, and return its
   * public URL plus the password ("auth key") the stream minted. The password
   * is generated BY the stream per start and held in memory there — the
   * session row is the only durable copy, which is the whole reason the row
   * caches it.
   */
  ensureStream(): Promise<{ streamUrl: string; streamPassword: string }>;
  /** Release the connection. Never kills the durable computer itself. */
  disconnect(): Promise<void>;
}

/** The session-store functions (browser-sessions-client), injectable. */
interface StoreLookupOptions {
  expectedBundleHash: string;
  /** Required: see `lookupBrowserSession`. `"any"` is the explicit
   *  opt-out; omission is rejected by the control plane. */
  expectedContextMode: BrowserContextMode | "any";
  /** The wire this build speaks; see `BROWSERD_PROTOCOL_VERSION`. */
  expectedProtocolVersion?: number;
  signal?: AbortSignal;
}

export interface SessionStore {
  // OVERLOADED per target, so a computer lookup keeps the computer TYPE and
  // this module never has to narrow a union to say "yes, the box I asked
  // about is the box I got".
  lookup(
    args: { computerId: string; sandboxRowId?: undefined } & StoreLookupOptions,
  ): Promise<ComputerBrowserSessionLookup>;
  lookup(
    args: {
      sandboxRowId: string;
      computerId?: undefined;
      watched?: boolean;
    } & StoreLookupOptions,
  ): Promise<SandboxBrowserSessionLookup>;
  record(
    args: ComputerBrowserSessionRecordArgs | SandboxBrowserSessionRecordArgs,
  ): Promise<BrowserSessionRecordResult>;
  /**
   * Take the exclusive right to relaunch this computer's browser.
   *
   * OPTIONAL, and its absence means "proceed as before". Two things arrive as
   * absence: a control plane that predates the route, and a test fake that has
   * no opinion about claims. Neither should turn a relaunch into a refusal —
   * the claim narrows a race that the record compare-and-swap still catches
   * afterwards, at the cost of a wasted boot.
   */
  claimRelaunch?(
    args: BrowserSessionTargetArgs & {
      claimId: string;
      ttlMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<BrowserRelaunchClaim>;
  /** Give it back. Best-effort: an unreleased claim expires on its own. */
  releaseRelaunch?(
    args: BrowserSessionTargetArgs & {
      claimId: string;
      signal?: AbortSignal;
    },
  ): Promise<void>;
  touch(args: {
    sessionId: string;
    kind: "command" | "panel";
    signal?: AbortSignal;
  }): Promise<{ counted: boolean }>;
}

export interface BrowserSessionDeps {
  /**
   * Reserve/ensure a desktop computer for this user+project; returns its row
   * id. MUST reserve with `runtimeKind: "desktop-browser"` — the plugin-box
   * precedent (`resolveColocatedPluginBox`) omits the kind and reserves a
   * terminal box, so it cannot be reused verbatim here.
   */
  reserveDesktop(args: {
    bearer: string;
    projectId: string;
    signal?: AbortSignal;
  }): Promise<{ computerId: string }>;
  /** Exchange a computer id for its vendor sandbox id. */
  resolveSandboxId(computerId: string): Promise<string>;
  /** Connect to the sandbox. */
  connect(sandboxId: string): Promise<SessionSandbox>;
  /** Boot browserd (the real `bootBrowserd` in production). */
  boot(
    sandbox: BrowserdSandbox,
    options: BootBrowserdOptions,
  ): Promise<BrowserdHandle>;
  /** Build the client for a daemon at `baseUrl` presenting `bearer`. */
  createClient(baseUrl: string, bearer: string): SessionClient;
  store: SessionStore;
  /** Optional durable logical-session adapter; absent keeps legacy behavior. */
  sessionService?: BrowserSessionService;
  /**
   * Keep the COMPUTER awake, as distinct from the session row.
   *
   * Optional because it is best-effort in the strictest sense: the row touch
   * is what the session sweep reads, and losing this one only risks an earlier
   * hibernate. Injected rather than imported so this module stays
   * orchestration with no control-plane dependency of its own.
   */
  touchActivity?: (args: { computerId: string }) => Promise<unknown>;
  /** The daemon bundle bytes to upload on a relaunch. */
  bundle(): Uint8Array;
  /** sha256 (hex) of those bytes — the row's `bundleHash` identity. */
  bundleHash(): string;
}

export interface EnsureBrowserSessionArgs {
  /** Attachment/resume may reuse this boot, never bootstrap a replacement. */
  expectedExistingBootId?: string;
  /** The USER whose desktop is reserved (their control-plane bearer). */
  bearer: string;
  projectId: string;
  /**
   * WHICH BOX this session runs on. Absent ⇒ the member's durable project
   * computer, byte-identical to every call that predates per-run boxes.
   *
   * `sandbox` names a box the CALLER HAS ALREADY PROVISIONED for this run —
   * both its control-plane row and its vendor id — so this path reserves
   * nothing and bills nothing. That is the whole point: an unattended run's
   * isolation is a property of the box it owns, not of a lease or a lock, and
   * the run is the only thing that knows which box is its own.
   */
  target?:
    | { kind: "computer" }
    | {
        kind: "sandbox";
        sandboxRowId: string;
        sandboxId: string;
        watched?: boolean;
        record?: boolean;
      };
  /**
   * Persistent Chrome profile (playground/inspector) unless stated.
   *
   * `ephemeral` boots the daemon with no profile directory at all, so an
   * eval or swarm iteration cannot inherit the previous one's cookies. The
   * mode is part of session identity: a row in the other mode is never
   * reused, because handing an eval a logged-in profile (or a human a blank
   * one) is a silent correctness failure either way.
   */
  contextMode?: BrowserContextMode;
  /** Durable logical identity, when this surface has one. */
  logicalSessionId?: string;
  /** Saved profile bytes to apply only if this ensure has to boot a daemon. */
  profileArchive?: Uint8Array;
  signal?: AbortSignal;
}

/**
 * A live browserd, whichever engine is running it.
 *
 * A UNION rather than one shape with optional fields, because the hosted
 * engine's identity (a Convex session row, a computer id, an E2B stream and
 * its password) does not exist on a laptop, and the alternative to a union is
 * placeholder strings — a `streamUrl: ""` that some future panel renders into
 * an iframe. `engine` is the discriminant; the hosted ensure functions below
 * return the hosted member specifically, so hosted call sites need no narrow.
 */
export type BrowserSessionHandle =
  HostedBrowserSessionHandle | LocalBrowserSessionHandle;

interface HostedBrowserSessionHandleCommon {
  engine: "hosted";
  sessionId: string;
  bootId: string;
  client: SessionClient;
  contextMode: BrowserContextMode;
  /** True when an existing daemon was verified and reused (no sandbox I/O). */
  reused: boolean;
  /**
   * This daemon speaks our wire but is running OLD BYTES.
   *
   * Not a problem to solve now. Relaunching mid-session rotates `bootId` and
   * the stream password, so every open pane and in-flight command breaks — and
   * during a wave of daemon work that would happen on almost every deploy, to
   * a person who is quite possibly mid-login. The replacement is scheduled for
   * the first moment nothing is using the browser.
   */
  upgradeAvailable?: boolean;
}

/**
 * A daemon on the member's durable computer — the Playground's browser, with
 * their logins, a panel that can watch it and a lease a person can take.
 */
export interface ComputerHostedBrowserSessionHandle
  extends HostedBrowserSessionHandleCommon {
  target: "computer";
  computerId: string;
  streamUrl: string;
  streamPassword: string;
}

/**
 * A daemon on a per-RUN disposable desktop box.
 *
 * NO STREAM, and that absence is the type doing its job: nobody is watching an
 * unattended run, so no stream is started and there is no password to hand
 * back. Making it a union member rather than optional fields is what stops a
 * `streamUrl: ""` placeholder from reaching a panel that would render it.
 */
export interface SandboxHostedBrowserSessionHandle
  extends HostedBrowserSessionHandleCommon {
  target: "sandbox";
  /** The control-plane row — the session's identity and its teardown hook. */
  sandboxRowId: string;
  /** The vendor box id the daemon actually runs in. */
  sandboxId: string;
  /** True only for a Playground box with a live, authenticated panel stream. */
  watched?: boolean;
  streamUrl?: string;
  streamPassword?: string;
}

export type HostedBrowserSessionHandle =
  ComputerHostedBrowserSessionHandle | SandboxHostedBrowserSessionHandle;

/**
 * A browserd running INSIDE this inspector process — the npm engine's
 * Chromium, or the desktop app's. No row, no reserve, no stream: the pane
 * reaches it through the same daemon the tools do.
 */
export interface LocalBrowserSessionHandle {
  engine: "local";
  /**
   * Which Chromium this is: one Playwright downloaded, or the desktop app's
   * own. `engine` stays `"local"` for both — the tools, the lease, the pane
   * and the approval rules are identical — and this exists so the consent
   * screen knows whether there is anything to install.
   */
  runtime: "playwright" | "electron";
  bootId: string;
  client: SessionClient;
  contextMode: BrowserContextMode;
  reused: boolean;
  /** Absent in ephemeral mode, which has no profile directory at all. */
  profileDir?: string;
}

/**
 * Ensure a verified-live browserd session on this user's desktop computer.
 * Serialized per computer (fixed port + one persistent profile per box), like
 * the probe. Throws on any failure — never leaving an unrecorded daemon
 * running.
 */
// OVERLOADED per target, for the same reason the store's lookup is: a caller
// that named the member's computer should not have to narrow a union to learn
// it got a computer back, and one that named a per-run box should get a handle
// whose type says there is no stream on it.
export async function ensureBrowserSession(
  deps: BrowserSessionDeps,
  args: EnsureBrowserSessionArgs & { target?: { kind: "computer" } },
): Promise<ComputerHostedBrowserSessionHandle>;
export async function ensureBrowserSession(
  deps: BrowserSessionDeps,
  args: EnsureBrowserSessionArgs & {
    target: {
      kind: "sandbox";
      sandboxRowId: string;
      sandboxId: string;
      watched?: boolean;
    };
  },
): Promise<SandboxHostedBrowserSessionHandle>;
export async function ensureBrowserSession(
  deps: BrowserSessionDeps,
  args: EnsureBrowserSessionArgs,
): Promise<HostedBrowserSessionHandle> {
  const contextMode = args.contextMode ?? "persistent";
  const target = args.target ?? { kind: "computer" };
  if (target.kind === "sandbox") {
    // A PER-RUN BOX, already provisioned by whatever asked for a browser.
    //
    // Nothing here reserves or bills: the run owns the box, and the box's
    // identity IS the isolation — no other run can resolve to it, so there is
    // no profile to share, no relaunch race across replicas and no human whose
    // page a restart could pull away.
    if (
      target.watched
        ? contextMode !== "persistent"
        : contextMode !== "ephemeral"
    ) {
      // The mode is not a preference here, it is what the box is FOR. A
      // persistent profile on a machine that dies with the run is a
      // contradiction, and accepting it would quietly promise durability
      // nothing can keep.
      throw new BrowserSessionTargetError(
        "persistent_requires_computer",
        target.watched
          ? "a watched Playground sandbox browser is always persistent"
          : "a per-run sandbox browser is always ephemeral: the box dies with " +
            "the run, so a persistent profile on it could keep nothing",
      );
    }
    // Keyed per BOX. Two ensures for one row serialize (the fixed port and one
    // daemon per box); two different rows never wait on each other.
    return withKeyedLock(`browser-session:sandbox:${target.sandboxRowId}`, () =>
      ensureOnSandbox(deps, target, contextMode, args),
    );
  }
  if (contextMode === "ephemeral") {
    // AN EPHEMERAL BROWSER MAY NOT RIDE THE PROJECT COMPUTER.
    //
    // There is exactly one hosted computer per (project, member), so every
    // unattended run in a project resolves to the SAME daemon, the same tab
    // and the same cookie jar — the sharing the ephemeral mode exists to
    // prevent, and which the local engine already refuses by name
    // (`owner_key_required`). Worse, the mode is part of session identity, so
    // an ephemeral request against the box a member is using mid-session is a
    // mismatch, and a mismatch is a relaunch: it `pkill`s their Chromium.
    //
    // An unattended run gets its own disposable box instead (its run sandbox,
    // booted from the desktop template) — see `EnsureBrowserSessionArgs.target`.
    // Until a caller names one, refusing is the only honest answer, and it
    // refuses BEFORE `reserveDesktop` so nothing is provisioned or billed on
    // the way to the error.
    throw new BrowserSessionTargetError(
      "ephemeral_requires_sandbox",
      "an unattended hosted browser needs its own sandbox: the project " +
        "computer is shared by every run in the project, so an ephemeral " +
        "session there would share one profile and would restart the " +
        "browser out from under whoever is using it. Name a sandbox target " +
        "instead.",
    );
  }
  const { computerId } = await deps.reserveDesktop({
    bearer: args.bearer,
    projectId: args.projectId,
    signal: args.signal,
  });
  return withKeyedLock(`browser-session:${computerId}`, () =>
    ensureOnComputer(deps, computerId, contextMode, args),
  );
}

/**
 * The requested session cannot be served by the target it names.
 *
 * A sibling of `BrowserSessionInUseError`, and carries a `code` for the same
 * reason `LocalBrowserUnavailableError` does: callers branch on the reason
 * rather than on message text.
 */
export class BrowserSessionTargetError extends Error {
  constructor(
    readonly code:
      | "ephemeral_requires_sandbox"
      | "persistent_requires_computer"
      | "unsupported_target",
    message: string,
  ) {
    super(message);
    this.name = "BrowserSessionTargetError";
  }
}

/**
 * Same as `ensureBrowserSession`, but for a computer the caller has ALREADY
 * proven it owns — the Browser Panel, whose short-lived token names the
 * computer and whose route re-checks the row's owner before calling here.
 *
 * It deliberately does not reserve. Reserving is a provisioning and billing
 * action that belongs to whatever asked for a browser in the first place (a
 * chat turn, an eval); a panel someone opened to LOOK at a machine must not be
 * able to conjure one. If the box is merely asleep, the sandbox connect below
 * resumes it, which is the case the panel actually needs.
 */
export async function attachBrowserSession(
  deps: BrowserSessionDeps,
  args: {
    computerId: string;
    contextMode?: BrowserContextMode;
    signal?: AbortSignal;
  },
  // Always the COMPUTER member: the panel adopts the browser on a machine it
  // has already proven it owns, and a per-run box has no panel to attach.
): Promise<ComputerHostedBrowserSessionHandle> {
  return withKeyedLock(`browser-session:${args.computerId}`, async () => {
    const contextMode =
      args.contextMode ??
      (await modeAlreadyRunning(deps, args.computerId, args.signal));
    return ensureOnComputer(deps, args.computerId, contextMode, {
      ...(args.signal ? { signal: args.signal } : {}),
    });
  });
}

/**
 * The profile mode ALREADY RUNNING on this computer, or `persistent`.
 *
 * An attach names no mode: the panel's caller wants "the browser on this
 * machine", not a particular profile. Defaulting to `persistent` regardless
 * meant an attach to a box running an ephemeral daemon was a mode mismatch,
 * and a mode mismatch is a relaunch — so opening a panel to LOOK at what was
 * happening destroyed it, and replaced it with a different profile. Adopting
 * whatever is there makes the attach the read-only act it reads as.
 *
 * `persistent` remains the answer when nothing is running, which is the case
 * this default was written for and the right one for a person.
 */
async function modeAlreadyRunning(
  deps: BrowserSessionDeps,
  computerId: string,
  signal?: AbortSignal,
): Promise<BrowserContextMode> {
  const lookup = await deps.store
    .lookup({
      computerId,
      expectedBundleHash: deps.bundleHash(),
      expectedContextMode: "any",
      ...(signal ? { signal } : {}),
    })
    .catch(() => null);
  return lookup?.session?.contextMode ?? "persistent";
}

/** Verify a looked-up COMPUTER row against the daemon itself. */
async function tryReuse(
  deps: BrowserSessionDeps,
  lookup: ComputerBrowserSessionLookup,
  contextMode: BrowserContextMode,
  signal?: AbortSignal,
  logicalContext?: LogicalSessionContext,
  /** Written when this gate is the one that refused. @see EnsureDiagnostics */
  diagnostics?: EnsureDiagnostics,
): Promise<ComputerHostedBrowserSessionHandle | null> {
  const session = lookup.session;
  if (!session) return null;
  // Belt-and-braces against the backend's own mode filter: a daemon running
  // the other profile mode is never reusable, whatever the row says, because
  // its browser state is the wrong kind (a persistent profile's cookies for
  // an eval, or an ephemeral one's blank slate for a signed-in user).
  if (session.contextMode !== contextMode) return null;
  const client = deps.createClient(session.publicOrigin, session.browserdToken);
  // Any transport failure counts as "not verified" — the relaunch path is the
  // recovery, so there is nothing better to do with the error.
  const status = await client.status().catch(() => null);
  if (!status || status.kind !== "ok" || status.bootId !== session.bootId) {
    return null;
  }
  // THE WIRE, NOT THE BYTES. A daemon whose protocol number differs (or which
  // is too old to announce one) cannot be proven compatible, and continuing
  // would produce wrong answers rather than merely old ones.
  //
  // CHECKED UNCONDITIONALLY. Only the BUNDLE HASH half below is a lazy-upgrade
  // decision — a hash difference is an upgrade that can wait for an idle
  // session. A wire difference is not an upgrade at all: it is a daemon that
  // answers `ok` for a `fill_form` it never ran, and switching the check off
  // with the rollback flag would restore exactly the failure the version
  // number exists to prevent.
  {
    const running = status.protocolVersion ?? session.protocolVersion;
    if (running !== BROWSERD_PROTOCOL_VERSION) {
      noteProtocolMismatch(
        diagnostics,
        {
          expected: BROWSERD_PROTOCOL_VERSION,
          running,
          source: "reuse",
        },
        { sessionId: session.sessionId, bootId: session.bootId },
      );
      return null;
    }
  }
  // Best-effort: losing the touch costs an earlier sweep, never this turn.
  void deps.store
    .touch({ sessionId: session.sessionId, kind: "command", signal })
    .catch(() => {});
  // A hash difference is an UPGRADE, not a refusal.
  const runningHash = status.bundleHash ?? session.bundleHash;
  const upgradeAvailable =
    lazyUpgradeEnabled() && !!runningHash && runningHash !== deps.bundleHash();
  // Taken NOW only if nothing is using the browser. A relaunch rotates the
  // bootId and the stream password, so every open pane and in-flight command
  // breaks; doing that to somebody mid-login to ship a comment change is the
  // failure this whole mechanism exists to end. Returning null here drops into
  // the ordinary relaunch path below, fence, claim and all.
  if (upgradeAvailable && daemonIsIdle(status)) return null;
  return handleFromRecord(
    deps,
    session,
    client,
    true,
    upgradeAvailable,
    logicalContext,
  );
}

/**
 * How long a browser must have gone untouched before an upgrade may take it.
 *
 * Generous on purpose: the cost of waiting is running old bytes for another
 * minute, and the cost of being wrong is a person's session ending mid-form.
 */
const UPGRADE_QUIET_MS = 60_000;

/**
 * Is nobody using this browser?
 *
 * EVERY fact must be present and must say idle. A daemon too old to report one
 * of them answers `undefined`, which is "unknown" — and an upgrade that read
 * unknown as idle would relaunch a browser somebody is watching, which is
 * precisely the behaviour V-4a removes.
 */
function daemonIsIdle(status: {
  lease?: "free" | "held" | "parked";
  watchers?: number;
  msSinceActivity?: number;
}): boolean {
  if (status.lease !== "free") return false;
  if (status.watchers === undefined || status.watchers > 0) return false;
  // Never touched at all is idle; touched recently is not.
  return (
    status.msSinceActivity === undefined ||
    status.msSinceActivity >= UPGRADE_QUIET_MS
  );
}

/**
 * Kill switch, read at CALL TIME.
 *
 * `false` restores the pre-V-4a behaviour exactly: a bundle hash that differs
 * relaunches the daemon there and then. Read per call rather than captured at
 * import so a deployment can flip it without a restart, and so a test can
 * exercise both paths in one process.
 */
function lazyUpgradeEnabled(): boolean {
  return process.env.MCPJAM_BROWSER_LAZY_UPGRADE !== "false";
}

/**
 * The same verification for a SANDBOX row.
 *
 * Deliberately a sibling rather than a generic: it verifies the same two
 * facts (the mode matches, the daemon answers with the recorded bootId) but
 * builds a handle with no stream, and touches only the session row — a per-run
 * box has no separate computer-activity clock, and the backend bumps its
 * `lastUsedAt` from the same touch.
 */
async function trySandboxReuse(
  deps: BrowserSessionDeps,
  lookup: SandboxBrowserSessionLookup,
  contextMode: BrowserContextMode,
  sandboxId: string,
  signal?: AbortSignal,
  logicalContext?: LogicalSessionContext,
): Promise<SandboxHostedBrowserSessionHandle | null> {
  const session = lookup.session;
  if (!session) return null;
  if (session.contextMode !== contextMode) return null;
  const client = deps.createClient(session.publicOrigin, session.browserdToken);
  const status = await client.status().catch(() => null);
  if (!status || status.kind !== "ok" || status.bootId !== session.bootId) {
    return null;
  }
  void deps.store
    .touch({ sessionId: session.sessionId, kind: "command", signal })
    .catch(() => {});
  return sandboxHandleFromRecord(
    deps,
    session,
    sandboxId,
    client,
    true,
    logicalContext,
  );
}

/**
 * The holder a relaunch fences with, and the ceiling on how long it may last.
 *
 * The prefix is load-bearing, not cosmetic: it is how a later relaunch tells
 * ITS OWN debris from a person. See `fenceForRelaunch`.
 */
const RELAUNCH_HOLDER_PREFIX = "relaunch:";
const RELAUNCH_FENCE_TTL_MS = 30_000;

/** A lease this relaunch is holding, to be given back if the kill fails. */
interface RelaunchFence {
  release(): Promise<void>;
}

interface RelaunchGate<
  Owner extends BrowserSessionLookup = BrowserSessionLookup,
> {
  /** The lease we took, or null when there was nothing to fence. */
  fence: RelaunchFence | null;
  /**
   * The row the ownership lookup saw, which may be a WINNER'S.
   *
   * Parameterised by TARGET, because the two arms return different rows: the
   * computer overload can only ever see a computer row, the sandbox overload
   * only a sandbox one. Pinning this to `ComputerBrowserSessionLookup`
   * hard-coded the computer arm's answer for both and made the sandbox arm
   * five type errors — invisible here only because this file's tsconfig is not
   * a CI gate.
   */
  owner: Owner | null;
}

/**
 * TAKE the lease before killing the daemon, so nobody can take it after we
 * looked.
 *
 * Reading the lease and then killing is a check-then-act with an HTTP round
 * trip in the middle: a person can press "Take control" inside that window and
 * have the page pulled away a moment later — the exact failure the check
 * exists to prevent, merely made rarer. The daemon's `acquire` is already an
 * atomic take-or-fail (`{took:false}` when somebody else holds it, evaluated
 * on the daemon's own event loop), so the honest version of this check is to
 * take the lease rather than to read it. Whoever loses the race loses it at
 * the daemon, once, and the winner is unambiguous.
 *
 * A `took` becomes a fence: while we hold it no pane can acquire, and the kill
 * below discards it along with the process. If the kill fails we hand it back,
 * because a lease left on a LIVE daemon blocks the agent and every person.
 *
 * OUR OWN DEBRIS IS NOT A PERSON. A fence outlives its relaunch if this
 * process dies between the take and the kill; on expiry it parks, and a parked
 * lease never auto-frees, so a naive refusal would then brick the box forever —
 * and brick it precisely because of the guard meant to protect it. Only this
 * function mints holders with `RELAUNCH_HOLDER_PREFIX`, so a hold under that
 * prefix can only be an interrupted relaunch, and stepping over it is the same
 * judgement `profile-lock.ts` makes about a stale `SingletonLock`.
 *
 * Best-effort about REACHING the daemon, never about the answer: a transport
 * failure or a client too old to have the endpoint means nobody could be
 * driving it through us either, so the relaunch proceeds — but a daemon that
 * answers "somebody else has it" always stops it.
 */
// OVERLOADED per target, for the same reason `SessionStore.lookup` is: the
// computer call site reads `owner` straight back into `tryReuse`, which takes
// a computer lookup, while the sandbox call site takes only the fence.
async function fenceForRelaunch(
  deps: BrowserSessionDeps,
  target: { computerId: string; sandboxRowId?: undefined },
  bundleHash: string,
  signal?: AbortSignal,
): Promise<RelaunchGate<ComputerBrowserSessionLookup>>;
async function fenceForRelaunch(
  deps: BrowserSessionDeps,
  target: { sandboxRowId: string; computerId?: undefined; watched?: boolean },
  bundleHash: string,
  signal?: AbortSignal,
): Promise<RelaunchGate<SandboxBrowserSessionLookup>>;
async function fenceForRelaunch(
  deps: BrowserSessionDeps,
  target: BrowserSessionTargetArgs,
  bundleHash: string,
  signal?: AbortSignal,
): Promise<RelaunchGate> {
  // `"any"`, because OWNERSHIP IS NOT MODE-SCOPED. The reuse lookup above asks
  // "is there a daemon I may run in?", and the backend answers `null` for a row
  // in the other profile mode — correctly, since an eval must never inherit a
  // signed-in profile. But this asks a different question: "is anyone holding
  // this box's browser?", and a persistent daemon with a person on it is the
  // most emphatic possible yes. Reusing the mode-filtered answer here read that
  // yes as "no row, nothing to protect" and killed them.
  const owner = await (target.computerId !== undefined
    ? deps.store.lookup({
        computerId: target.computerId,
        expectedBundleHash: bundleHash,
        expectedContextMode: "any",
        ...(signal ? { signal } : {}),
      })
    : deps.store.lookup({
        sandboxRowId: target.sandboxRowId,
        ...(target.watched ? { watched: true } : {}),
        expectedBundleHash: bundleHash,
        expectedContextMode: "any",
        ...(signal ? { signal } : {}),
      })
  ).catch(() => null);
  // RESIDUAL, and named rather than papered over: the backend checks the bundle
  // hash BEFORE the mode, so a daemon booted from a previous bundle answers
  // `null` here too and its holder is not protected. That is not a corner —
  // every daemon change rotates the hash, so the first relaunch after a deploy
  // is exactly this case. Closing it needs the control plane to hand back a
  // stale row's credentials for an ownership read, which is a backend change
  // and belongs in the backend PR, not smuggled into this one.
  // A STALE ROW STILL HAS A DAEMON. The lookup above answers `null` the moment
  // the bundle hash has moved — and every daemon change rotates it, so right
  // after each deploy this is the state EVERY box is in. Reading that as "no
  // row, nothing to protect" is what killed people mid-login on the first
  // relaunch after every release.
  //
  // The control plane now hands back just enough of such a row to ask its
  // daemon who is holding it. Absent means there is genuinely nobody to ask —
  // the box is not serving, or the control plane predates the field — and the
  // relaunch proceeds exactly as it did before, which is what lets this ship
  // ahead of the backend.
  const askable = owner?.session ?? owner?.staleSession;
  if (!askable) return { fence: null, owner: owner ?? null };
  const client = deps.createClient(askable.publicOrigin, askable.browserdToken);
  const holder = `${RELAUNCH_HOLDER_PREFIX}${randomUUID()}`;
  const taken = await client
    .leaseAction?.({
      action: "acquire",
      holder,
      ttlMs: RELAUNCH_FENCE_TTL_MS,
      // A relaunch is not a person at a keyboard, and the resume note that
      // names the kind would be a lie if it said otherwise.
      kind: "script",
    })
    .catch(() => null);
  if (!taken) return { fence: null, owner: owner ?? null };
  if (taken.took) {
    return {
      owner: owner ?? null,
      fence: {
        async release() {
          await client
            .leaseAction?.({ action: "resume", holder })
            .catch(() => {});
        },
      },
    };
  }
  const state = taken.lease;
  if (state.state !== "held" && state.state !== "parked") {
    // Refused without anybody holding it — not an answer we can act on, and
    // not one that says a person is there.
    return { fence: null, owner: owner ?? null };
  }
  if (state.holder.startsWith(RELAUNCH_HOLDER_PREFIX)) {
    // Another relaunch minted this hold, and WHICH STATE IT IS IN decides
    // everything.
    //
    // `parked` is debris: the fence outlived its relaunch, so more than its
    // whole TTL has passed with nobody finishing. Stepping over it is what
    // stops an interrupted relaunch from bricking the box forever.
    //
    // `held` is a relaunch IN PROGRESS — another replica inside its own thirty
    // seconds, quite possibly mid-boot. Reading that as debris and killing the
    // daemon underneath it is the same collision the fence exists to prevent,
    // only now between two of us instead of a person and an agent. Refuse and
    // let their boot finish; the row they record is the one the next ensure
    // reuses.
    if (state.state === "parked") return { fence: null, owner: owner ?? null };
    throw new BrowserSessionInUseError(
      "another replica is restarting this browser right now; try again in a moment",
    );
  }
  throw new BrowserSessionInUseError(
    state.state === "held"
      ? "somebody is using this browser right now; restarting it would take the page out from under them"
      : "somebody still holds this browser — their pane stopped responding, but the session is theirs until they hand it back",
  );
}

/**
 * What the reuse gates SAW on the way to deciding to relaunch.
 *
 * Three gates refuse a running daemon on a protocol mismatch — reuse,
 * prelaunch adoption, and the control-plane lookup — and all three do it by
 * returning `null`, which the caller reads as "nothing to reuse" and answers
 * with a kill-and-reboot. That is the RIGHT behaviour and stays: a daemon
 * nobody can prove they can talk to should be replaced, silently, without
 * bothering anyone.
 *
 * The failure is what happens when the relaunch ALSO fails. The `null` carried
 * no reason, so the error the user finally saw was `browserd did not report
 * listening within 30000ms` — a timeout, from a boot that had nothing to do
 * with the actual problem, and nothing anywhere named the wire.
 *
 * So each gate writes here on its way past, and only the failure path reads it.
 * Module-private: it is a breadcrumb for one `ensure`, not a return value.
 */
interface EnsureDiagnostics {
  protocolMismatch?: {
    expected: number;
    /** What the daemon announced, or `undefined` when it announced nothing. */
    running: number | undefined;
    /** The control plane's own word for it, when the lookup is what refused. */
    stale?: string;
    source: "reuse" | "adopt" | "lookup";
  };
}

/**
 * Record a protocol refusal, and say so in the log.
 *
 * WARN rather than info: this is a daemon being killed and replaced under
 * whatever was using it, and the whole reason it is invisible today is that
 * nothing wrote it down. The relaunch usually works and nobody ever reads
 * this; when it does not, this line is the difference between a named cause
 * and a boot timeout.
 */
function noteProtocolMismatch(
  diagnostics: EnsureDiagnostics | undefined,
  mismatch: NonNullable<EnsureDiagnostics["protocolMismatch"]>,
  context: Record<string, unknown> = {},
): void {
  if (diagnostics) diagnostics.protocolMismatch = mismatch;
  logger.warn("[browser-session] browser.protocol_mismatch", {
    ...context,
    ...mismatch,
  });
}

/**
 * The relaunch failed, and a protocol mismatch is why it was attempted.
 *
 * NOT thrown when the relaunch merely failed: a boot that timed out for its
 * own reasons must keep reporting its own reason, or this error becomes a
 * wrapper that hides whatever actually went wrong. It is thrown only when a
 * gate recorded a mismatch AND the recovery for that mismatch did not land —
 * which is the one case where "the daemon speaks a different wire" is the
 * true and complete explanation.
 *
 * The message is prefixed with the code so `parseBrowserdErrorCode` reads it
 * back out of a result's `error` string, the same as every daemon-side code.
 */
export class BrowserProtocolMismatchError extends Error {
  readonly code = "protocol_mismatch";
  readonly expected: number;
  readonly running: number | undefined;
  readonly stale: string | undefined;
  readonly hint: string;
  constructor(mismatch: NonNullable<EnsureDiagnostics["protocolMismatch"]>) {
    const running =
      mismatch.running === undefined
        ? "a version it did not announce"
        : `version ${mismatch.running}`;
    const hint =
      "This browser needs to be restarted onto the current build; the " +
      "automatic restart did not succeed. Try again, and if it persists the " +
      "box itself needs replacing.";
    super(
      formatBrowserdError(
        "protocol_mismatch",
        `the running browser daemon speaks ${running}, this server speaks ` +
          `version ${mismatch.expected}. ${hint}`,
      ),
    );
    this.name = "BrowserProtocolMismatchError";
    this.expected = mismatch.expected;
    this.running = mismatch.running;
    this.stale = mismatch.stale;
    this.hint = hint;
  }
}

/**
 * Run the relaunch; if it fails AND a gate blamed the wire, say the wire.
 *
 * THE WHOLE SHAPE OF THE FIX. The relaunch stays silent and stays first — a
 * daemon speaking the wrong wire should be replaced without bothering anybody,
 * and almost always is. Only when the replacement ALSO fails does the reason
 * matter, and then it is the difference between
 *
 *   browserd did not report listening within 30000ms
 *
 * and a sentence naming both versions. The raw error is RETHROWN UNCHANGED
 * when no mismatch was recorded: a boot that failed for its own reasons must
 * keep reporting its own reason, or this helper becomes a wrapper that hides
 * whatever actually went wrong.
 */
async function namingProtocolMismatch<T>(
  diagnostics: EnsureDiagnostics,
  relaunch: () => Promise<T>,
): Promise<T> {
  try {
    return await relaunch();
  } catch (error) {
    const mismatch = diagnostics.protocolMismatch;
    if (!mismatch) throw error;
    logger.warn("[browser-session] browser.protocol_mismatch_unrecovered", {
      ...mismatch,
      bootError: error instanceof Error ? error.message : String(error),
    });
    throw new BrowserProtocolMismatchError(mismatch);
  }
}

/** The relaunch was refused because a person holds the browser. */
export class BrowserSessionInUseError extends Error {
  readonly code = "browser_in_use";
  constructor(detail: string) {
    super(formatBrowserdError("lease_held", detail));
    this.name = "BrowserSessionInUseError";
  }
}

/**
 * EVERY COMMAND IS ACTIVITY.
 *
 * Before this, a browser session was touched once per `ensureBrowserSession` —
 * and a turn ensures once and then drives for minutes. The session sweep (30
 * min idle) and the computer's own hibernation both read those clocks, so a
 * long agent run reading and clicking the whole time looked exactly like an
 * abandoned box and could be reaped mid-turn. The panel keepalive papered over
 * it whenever somebody happened to be watching, which is precisely the case
 * that did not need help.
 *
 * FIRE-AND-FORGET, AND AT ISSUE. Neither touch may add latency to a command or
 * fail one, so both are unawaited and both swallow their errors. Issuing at
 * the start rather than on completion is deliberate: a command that takes
 * thirty seconds, or never returns at all, is still the box being used.
 */
interface LogicalSessionContext {
  sessionId: string;
  projectId: string;
  bearer: string;
}

function withActivityTouches(
  deps: BrowserSessionDeps,
  session: { sessionId: string; computerId?: string },
  client: SessionClient,
  logicalContext?: LogicalSessionContext,
): SessionClient {
  // Rebuilt method by method rather than spread: `client` is usually a
  // `BrowserdClient` INSTANCE, whose methods live on the prototype and would
  // not survive `{ ...client }`.
  return {
    status: (options) => client.status(options),
    sendCommand: (command, expectedBootId) => {
      // UNTHROTTLED on purpose: this one is load-bearing. It advances the
      // browser session's own clock and, for a sandbox box, that box's
      // `lastUsedAt` in the SAME backend transaction — which is what keeps the
      // sleep sweep and the reaper from taking a box out from under a run.
      void deps.store
        .touch({ sessionId: session.sessionId, kind: "command" })
        .catch(() => {});
      if (deps.sessionService && logicalContext) {
        // THROTTLED, unlike the store touch above: this is a SECOND
        // control-plane round-trip to a different row, and nothing reads its
        // clock to make a decision — the logical session's `lastActiveAt` is
        // display only. Once a minute keeps it honest for a fraction of the
        // writes. Revisit the moment a sweep is wired onto that column.
        if (shouldTouchSessionCommand(`logical:${logicalContext.sessionId}`)) {
          void deps.sessionService
            .touch({
              sessionId: logicalContext.sessionId,
              projectId: logicalContext.projectId,
              bearer: logicalContext.bearer,
              kind: "command",
            })
            .catch(() => {});
        }
        // Tabs used to refresh on every 5th command, which on an agent run is
        // a daemon round-trip plus a POST every few seconds. Nothing consumes
        // this list live — it is surfaced for display — so it rides the same
        // once-a-minute window on its own key.
        if (shouldTouchSessionCommand(`tabs:${logicalContext.sessionId}`)) {
          void client
            .status()
            .then((status) => {
              if (!("tabs" in status) || !status.tabs) return;
              return deps.sessionService?.setTabs({
                sessionId: logicalContext.sessionId,
                projectId: logicalContext.projectId,
                bearer: logicalContext.bearer,
                tabs: status.tabs.map((tab) => ({
                  tabId: tab.id,
                  url: tab.url,
                  title: "",
                })),
              });
            })
            .catch(() => {});
        }
      }
      // The COMPUTER's own hibernation clock. A per-run box has none — it is
      // never hibernated, and the backend advances its `lastUsedAt` from the
      // session touch above, in the same transaction.
      const computerId = session.computerId;
      if (deps.touchActivity && computerId && shouldTouchActivity(computerId)) {
        void deps.touchActivity({ computerId }).catch(() => {});
      }
      return client.sendCommand(command, expectedBootId);
    },
    // ARGUMENTS FORWARDED, not just the call. A wrapper that took none
    // silently dropped the abort signal the handoff poll passes, so a
    // cancelled turn went on holding a lease read nobody was waiting for.
    ...(client.lease
      ? {
          lease: (options?: { signal?: AbortSignal }) => client.lease!(options),
        }
      : {}),
    ...(client.leaseAction
      ? { leaseAction: (args) => client.leaseAction!(args) }
      : {}),
    // FORWARDED EXPLICITLY, like everything above it. This function rebuilds
    // the client method by method (a `BrowserdClient` INSTANCE keeps its
    // methods on the prototype, so a spread would drop all of them), which
    // means a capability added to the client and not added here silently stops
    // existing at every hosted call site — and for recording that is a run
    // that quietly leaves no evidence, with nothing to see in a log.
    ...(client.record ? { record: (args) => client.record!(args) } : {}),
    ...(client.recordStatus
      ? { recordStatus: () => client.recordStatus!() }
      : {}),
    // Exactly the capability the comment above warns about: without this line
    // a daemon that CAN export a profile looks like one that cannot, and the
    // panel answers `profile_export_unavailable` on a browser that would have
    // exported fine.
    ...(client.exportProfile
      ? { exportProfile: () => client.exportProfile!() }
      : {}),
  };
}

function handleFromRecord(
  deps: BrowserSessionDeps,
  session: ComputerBrowserSessionRecord,
  client: SessionClient,
  reused: boolean,
  upgradeAvailable = false,
  logicalContext?: LogicalSessionContext,
): ComputerHostedBrowserSessionHandle {
  return {
    engine: "hosted",
    target: "computer",
    sessionId: session.sessionId,
    computerId: session.computerId,
    bootId: session.bootId,
    client: withActivityTouches(deps, session, client, logicalContext),
    streamUrl: session.streamUrl,
    streamPassword: session.streamPassword,
    contextMode: session.contextMode,
    reused,
    ...(upgradeAvailable ? { upgradeAvailable: true } : {}),
  };
}

function sandboxHandleFromRecord(
  deps: BrowserSessionDeps,
  session: SandboxBrowserSessionRecord,
  sandboxId: string,
  client: SessionClient,
  reused: boolean,
  logicalContext?: LogicalSessionContext,
): SandboxHostedBrowserSessionHandle {
  return {
    engine: "hosted",
    target: "sandbox",
    sessionId: session.sessionId,
    sandboxRowId: session.sandboxRowId,
    sandboxId,
    bootId: session.bootId,
    client: withActivityTouches(deps, session, client, logicalContext),
    contextMode: session.contextMode,
    reused,
    ...(session.watched ? { watched: true } : {}),
    ...(session.stream
      ? {
          streamUrl: session.stream.url,
          streamPassword: session.stream.password,
        }
      : {}),
  };
}

/**
 * Adopt a daemon the BOX started, if it can prove it is ours to use.
 *
 * Every step here is a refusal that costs one round trip and saves a relaunch;
 * failing any of them falls through to the ordinary path, which is what a box
 * whose image predates prelaunch does on every ensure.
 */
async function tryAdoptPrelaunched(
  deps: BrowserSessionDeps,
  sandbox: SessionSandbox,
  target: {
    computerId: string;
    contextMode: BrowserContextMode;
    observedSessionId?: string;
    logicalSessionId?: string;
    projectId?: string;
    bearer?: string;
    logicalContext?: LogicalSessionContext;
  },
  signal?: AbortSignal,
  /** Written when this gate is the one that refused. @see EnsureDiagnostics */
  diagnostics?: EnsureDiagnostics,
): Promise<ComputerHostedBrowserSessionHandle | null> {
  if (process.env.MCPJAM_BROWSER_PRELAUNCH_ADOPT === "false") return null;
  const token = await sandbox
    .readTextFile?.(BROWSERD_TOKEN_FILE)
    .catch(() => undefined);
  // No file: an image that predates prelaunch, or a daemon this inspector
  // booted itself (which is handed its token rather than minting one).
  if (!token) return null;

  const publicOrigin = `https://${sandbox.browserd.getHost(BROWSERD_PORT)}`;
  const client = deps.createClient(publicOrigin, token);
  const status = await client.status().catch(() => null);
  if (!status || status.kind !== "ok") return null;
  // THE BOX STARTED IT, not an inspector. A daemon an inspector booted has a
  // row of its own, and adopting it here would write a second row for the same
  // process under a token the first row does not know.
  if (status.startedBy !== "prelaunch") return null;
  if (status.protocolVersion !== BROWSERD_PROTOCOL_VERSION) {
    // A BAKED-IN DAEMON GOES STALE ON ITS OWN. The image carries one; the
    // server rolls forward past it; nothing on the box knows. Until this line
    // existed, the only trace of that was a relaunch on every single ensure.
    noteProtocolMismatch(
      diagnostics,
      {
        expected: BROWSERD_PROTOCOL_VERSION,
        running: status.protocolVersion,
        source: "adopt",
      },
      { computerId: target.computerId, bootId: status.bootId },
    );
    return null;
  }
  // A daemon in the wrong profile mode is never adoptable: its browser state
  // is the wrong kind (a persistent profile's cookies for an eval, or an
  // ephemeral one's blank slate for a signed-in user).
  if (status.contextMode !== target.contextMode) return null;

  const { streamUrl, streamPassword } = await sandbox.ensureStream();
  const recorded = await deps.store.record({
    computerId: target.computerId,
    bootId: status.bootId,
    browserdToken: token,
    browserdPort: BROWSERD_PORT,
    publicOrigin,
    // The stream rides the TARGET now — required here, refused on a per-run
    // box — so it is passed as the computer overload's `stream`, not as two
    // loose fields.
    stream: { url: streamUrl, password: streamPassword },
    // The hash of the bundle WE would have uploaded, so a later lookup can see
    // the drift: a baked daemon is old bytes by design, and the lazy upgrade is
    // what replaces it once nobody is looking.
    bundleHash: deps.bundleHash(),
    protocolVersion: BROWSERD_PROTOCOL_VERSION,
    contextMode: target.contextMode,
    ...(target.logicalSessionId
      ? { logicalSessionId: target.logicalSessionId }
      : {}),
    ...(target.observedSessionId
      ? { replacesSessionId: target.observedSessionId }
      : {}),
    ...(signal ? { signal } : {}),
  });
  // A lost compare-and-swap means another replica recorded first. Their row
  // describes this same daemon or a newer one; either way the ordinary path
  // below re-reads and verifies, which is a better answer than guessing here.
  if (recorded.status !== "recorded") return null;

  const session: ComputerBrowserSessionRecord = {
    sessionId: recorded.sessionId,
    target: "computer",
    computerId: target.computerId,
    bootId: status.bootId,
    browserdToken: token,
    browserdPort: BROWSERD_PORT,
    publicOrigin,
    streamUrl,
    streamPassword,
    bundleHash: deps.bundleHash(),
    protocolVersion: BROWSERD_PROTOCOL_VERSION,
    contextMode: target.contextMode,
  };
  // Baked bytes are old bytes by design: `upgradeAvailable` when the image's
  // daemon is not the one this build ships, replaced the first moment nobody
  // is holding the lease, watching, or driving it.
  const stale = !!status.bundleHash && status.bundleHash !== deps.bundleHash();
  return handleFromRecord(
    deps,
    session,
    client,
    true,
    stale,
    target.logicalContext,
  );
}

/**
 * The display settings a hosted daemon boots with.
 *
 * `MCPJAM_HOSTED_BROWSER_DPR` is how a deployment tries a sharper display
 * without shipping one — the gate is x264 under 60% of one core at 20fps on a
 * 2 vCPU box, and until a measurement passes it the answer is 1.
 *
 * NEVER for an ephemeral context. That is an eval or a swarm iteration, where a
 * screenshot on one host has to match a screenshot on another (L5); the daemon
 * pins its scale factor at 1 there too, and this is the belt to that braces.
 */
function hostedDisplayEnv(contextMode: BrowserContextMode): {
  deviceScaleFactor?: number;
  kiosk?: boolean;
} {
  const kiosk = process.env.MCPJAM_BROWSER_VIDEO !== "false";
  if (contextMode !== "persistent") return { kiosk };
  const raw = Number(process.env.MCPJAM_HOSTED_BROWSER_DPR);
  const dpr =
    Number.isFinite(raw) && raw >= 1 && raw <= 3 ? raw : HOSTED_DISPLAY.dpr;
  return { kiosk, ...(dpr !== 1 ? { deviceScaleFactor: dpr } : {}) };
}

/** Refuse to continue once the caller has gone away. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("browser session establishment aborted");
  }
}

async function bindLogicalBox(
  deps: BrowserSessionDeps,
  args: {
    logicalSessionId?: string;
    projectId?: string;
    bearer?: string;
    signal?: AbortSignal;
  },
  box: { computerId: string } | { sandboxRowId: string },
): Promise<void> {
  if (!args.logicalSessionId || !deps.sessionService) return;
  if (!args.projectId || !args.bearer) {
    throw new Error(
      "logical browser session requires project and bearer context",
    );
  }
  const bound = await deps.sessionService.bindBox({
    sessionId: args.logicalSessionId,
    projectId: args.projectId,
    bearer: args.bearer,
    box,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!bound) {
    throw new Error(
      "logical browser session could not be bound to its browser box",
    );
  }
}

function logicalContextFromArgs(args: {
  logicalSessionId?: string;
  projectId?: string;
  bearer?: string;
}): LogicalSessionContext | undefined {
  if (!args.logicalSessionId || !args.projectId || !args.bearer) {
    return undefined;
  }
  return {
    sessionId: args.logicalSessionId,
    projectId: args.projectId,
    bearer: args.bearer,
  };
}

async function recordLogicalBoot(
  deps: BrowserSessionDeps,
  args: {
    logicalSessionId?: string;
    projectId?: string;
    bearer?: string;
    signal?: AbortSignal;
  },
  bootId: string,
): Promise<void> {
  if (!args.logicalSessionId || !deps.sessionService) return;
  if (!args.projectId || !args.bearer) {
    throw new Error(
      "logical browser session requires project and bearer context",
    );
  }
  const recorded = await deps.sessionService.recordBoot({
    sessionId: args.logicalSessionId,
    projectId: args.projectId,
    bearer: args.bearer,
    bootId,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!recorded)
    throw new Error("logical browser session boot was not recorded");
}

/** What the shared relaunch tail ended up doing. */
type BootOutcome<THandle> =
  /** Our daemon is up AND recorded; it now outlives this call. */
  | { kind: "booted"; booted: BrowserdHandle; sessionId: string }
  /** Another replica won; ours is stopped and theirs is verified. */
  | { kind: "adopted"; handle: THandle };

/**
 * THE TAIL EVERY RELAUNCH SHARES: upload the bundle, boot the daemon, publish
 * it — and adopt whoever won if another replica got there first.
 *
 * Extracted because the two arms differ only in what publishing MEANS (a
 * computer's row carries a stream and its password; a per-run box's does not)
 * and in what "look again" resolves to. Everything that is easy to get wrong
 * is here, once: the boot-race retry that reuses a winner instead of failing,
 * the compare-and-swap, and the rule that a daemon which cannot be recorded is
 * stopped rather than left running where no replica could ever find it.
 *
 * The caller still owns the `finally` that stops an unrecorded daemon: a
 * `booted` result hands the handle back precisely so the caller can clear its
 * own cleanup once the record has landed.
 */
async function bootAndPublish<THandle>(
  deps: BrowserSessionDeps,
  args: {
    sandbox: SessionSandbox;
    contextMode: BrowserContextMode;
    profileArchive?: Uint8Array;
    /** Re-read the store for THIS target and verify what comes back. */
    reuseAgain: () => Promise<THandle | null>;
    /**
     * Write the row for THIS target. Called once the daemon is up, and owns
     * anything that has to happen in between (the computer arm starts its
     * stream here, because the row is the only durable copy of the password).
     */
    publish: (booted: BrowserdHandle) => Promise<BrowserSessionRecordResult>;
    /** Stop the daemon we booted, on the way to adopting somebody else's. */
    onAdopt?: () => void;
  },
): Promise<BootOutcome<THandle>> {
  if (args.profileArchive) {
    await args.sandbox.writeBundle(
      BROWSERD_PROFILE_ARCHIVE_PATH,
      args.profileArchive,
    );
  }
  await args.sandbox.writeBundle(BROWSERD_SCRIPT_PATH, deps.bundle());
  let booted: BrowserdHandle;
  try {
    booted = await deps.boot(args.sandbox.browserd, {
      scriptPath: BROWSERD_SCRIPT_PATH,
      port: BROWSERD_PORT,
      userDataDir: BROWSERD_USER_DATA_DIR,
      contextMode: args.contextMode,
      ...(args.profileArchive
        ? { profileArchivePath: BROWSERD_PROFILE_ARCHIVE_PATH }
        : {}),
      // Applied to BOTH targets: a per-run desktop box has a display for the
      // same reason a computer does, and `hostedDisplayEnv` already keeps the
      // scale factor pinned at 1 for an ephemeral context — which is every
      // sandbox session — so an eval screenshot stays comparable across hosts.
      ...hostedDisplayEnv(args.contextMode),
    });
  } catch (bootError) {
    // Another replica may have won the boot race for this box (the keyed lock
    // is per-process only): before failing, ask the store once more and reuse
    // a daemon that verifies.
    const raced = await args.reuseAgain();
    if (raced) return { kind: "adopted", handle: raced };
    throw bootError;
  }

  const recorded = await args.publish(booted);
  if (recorded.status === "conflict") {
    // Stop our own daemon first (the winner's session must be verified against
    // a box we are no longer fighting over), then adopt the winner.
    await booted.stop().catch(() => {});
    args.onAdopt?.();
    const adopted = await args.reuseAgain();
    if (adopted) return { kind: "adopted", handle: adopted };
    throw new Error(
      "browser session record lost a boot race and the winning session did not verify",
    );
  }
  if (recorded.status === "unsupported_target") {
    // A control plane that does not know this kind of target. Stop the daemon
    // rather than leave one running that nothing can ever address.
    await booted.stop().catch(() => {});
    args.onAdopt?.();
    throw new BrowserSessionTargetError(
      "unsupported_target",
      "this control plane does not support a per-run browser session yet",
    );
  }
  if (recorded.status !== "recorded") {
    throw new Error(
      "browser session record did not land — refusing a runtime no replica could find",
    );
  }
  return { kind: "booted", booted, sessionId: recorded.sessionId };
}

/**
 * Ensure a verified-live browserd on a PER-RUN box.
 *
 * Deliberately much shorter than the computer path, and every omission is a
 * decision:
 *
 *   - An unattended run takes NO relaunch claim and NO lease fence: it has one
 *     run and one driving process, and no panel can reach it. A watched
 *     Playground box takes both, because it is shared persistent state that a
 *     person may be using while a relaunch is being considered.
 *   - NO `resolveSandboxId`. The caller provisioned this box and already
 *     holds its vendor id; asking the control plane to resolve one again would
 *     be a round trip to learn something we were handed.
 *   - NO wake-then-ask-again. A per-run box is `live` or it is gone — there is
 *     no paused state whose probe failure would be a false negative.
 *   - NO stream. Nobody is watching.
 */
async function ensureOnSandbox(
  deps: BrowserSessionDeps,
  target: { sandboxRowId: string; sandboxId: string; watched?: boolean },
  contextMode: BrowserContextMode,
  args: Pick<
    EnsureBrowserSessionArgs,
    "signal" | "logicalSessionId" | "profileArchive" | "expectedExistingBootId"
  > &
    Partial<Pick<EnsureBrowserSessionArgs, "bearer" | "projectId">>,
): Promise<SandboxHostedBrowserSessionHandle> {
  const bundleHash = deps.bundleHash();
  const logicalContext = logicalContextFromArgs(args);
  // @see EnsureDiagnostics — one bag per ensure, read only on the failure path.
  const diagnostics: EnsureDiagnostics = {};
  if (!args.expectedExistingBootId)
    await bindLogicalBox(deps, args, { sandboxRowId: target.sandboxRowId });
  const lookupArgs = {
    sandboxRowId: target.sandboxRowId,
    ...(target.watched ? { watched: true } : {}),
    expectedBundleHash: bundleHash,
    expectedContextMode: contextMode,
    ...(args.signal ? { signal: args.signal } : {}),
  };

  const lookup = await deps.store.lookup(lookupArgs);
  // REFUSE BEFORE CONNECTING. A control plane that does not know this target
  // shape will refuse the record too, so booting first would pay a cold
  // desktop boot — the most expensive thing on this path — on every attempt,
  // to reach the same failure. This is what makes the inspector safe to ship
  // ahead of the backend.
  if (lookup.unsupportedTarget) {
    throw new BrowserSessionTargetError(
      "unsupported_target",
      "this control plane does not support a per-run browser session yet",
    );
  }
  // The control plane refused this row before we reached the daemon at all.
  // `protocol_changed` is the one staleness that still means "relaunch now";
  // recording it is what lets a failed relaunch say so.
  if (lookup.stale === "protocol_changed") {
    noteProtocolMismatch(
      diagnostics,
      {
        expected: BROWSERD_PROTOCOL_VERSION,
        running: lookup.session?.protocolVersion,
        stale: lookup.stale,
        source: "lookup",
      },
      {
        sandboxRowId: target.sandboxRowId,
        sessionId: lookup.observedSessionId,
      },
    );
  }
  const reusedHandle = await trySandboxReuse(
    deps,
    lookup,
    contextMode,
    target.sandboxId,
    args.signal,
    logicalContext,
  );
  if (reusedHandle) {
    if (
      args.expectedExistingBootId &&
      reusedHandle.bootId !== args.expectedExistingBootId
    ) {
      throw new Error(
        "The browser boot changed. Reconnect after checking this session; no commands were replayed.",
      );
    }
    return reusedHandle;
  }
  if (
    target.watched &&
    (args.expectedExistingBootId ||
      lookup.session ||
      lookup.observedSessionId ||
      lookup.stale ||
      !lookup.reachable)
  ) {
    // WHY it is not ready, when we know. A watched sandbox is a person waiting
    // on a pane, and "not ready, retry" is advice that cannot work when the
    // daemon on the box speaks a wire this server cannot talk to: retrying
    // reaches the same refusal forever.
    if (diagnostics.protocolMismatch) {
      throw new BrowserProtocolMismatchError(diagnostics.protocolMismatch);
    }
    throw new Error(
      "The existing browser is not ready. Retry connecting; it has not been restarted or replaced.",
    );
  }

  // An aborted lookup comes back indistinguishable from "no session" — the
  // client never throws — so check the signal before booting on that answer.
  throwIfAborted(args.signal);

  const startedAt = Date.now();
  const sandbox = await deps.connect(target.sandboxId);
  const connectedAt = Date.now();
  let handle: BrowserdHandle | undefined;
  let stream: { streamUrl: string; streamPassword: string } | undefined;
  const reuseAgain = async () =>
    trySandboxReuse(
      deps,
      await deps.store.lookup(lookupArgs),
      contextMode,
      target.sandboxId,
      args.signal,
      logicalContext,
    );
  let releaseClaim: () => Promise<void> = async () => {};
  let fence: RelaunchFence | null = null;
  try {
    // A WINNER MAY HAVE APPEARED WHILE WE WERE CONNECTING.
    //
    // `killBrowserd` is a `pkill` on the box, so it would reap a daemon
    // another party booted in the meantime and leave their row addressing
    // nothing — and the record compare-and-swap below cannot repair that,
    // because it fires after the kill and the damage IS the kill. An
    // unattended per-run box has exactly one owner, but a watched Playground
    // box is shared and uses the same control-plane relaunch fence as the
    // computer path.
    //
    // For an unattended box the work that owns it is claimed exactly
    // once a layer up (a swarm attempt whose claim came back `applied: false`
    // skips before it ever provisions, and two eval runners of one run mint
    // distinct iteration ids, hence distinct boxes). So there is no second
    // driver to serialize against.
    //
    // Re-reading the store before the kill is nonetheless worth its one round
    // trip: connecting to a box takes seconds, it costs a fraction of the
    // desktop boot it guards, and it means the kill is conditional on what we
    // still believe is there rather than on a lookup from before we connected.
    const raced = await reuseAgain();
    if (raced) return raced;

    if (target.watched) {
      const claimId = randomUUID();
      const claimed = await deps.store.claimRelaunch?.({
        sandboxRowId: target.sandboxRowId,
        watched: true,
        claimId,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      // Only a REFUSAL stops us, exactly as on the computer arm. `undefined`
      // (no claim support) and `unavailable` (unreachable, unconfigured, or a
      // control plane that predates the sandbox claim shape and answers 400)
      // both proceed unclaimed — otherwise every watched relaunch fails
      // against the backend this module is written to ship ahead of, and fails
      // naming a replica that does not exist.
      if (claimed?.ok === false && claimed.reason === "claimed") {
        throw new BrowserSessionInUseError(
          "another replica is restarting this browser right now; try again in a moment",
        );
      }
      if (claimed?.ok === true) {
        releaseClaim = async () => {
          await deps.store
            .releaseRelaunch?.({
              sandboxRowId: target.sandboxRowId,
              watched: true,
              claimId,
              ...(args.signal ? { signal: args.signal } : {}),
            })
            .catch(() => {});
        };
      }

      fence = (
        await fenceForRelaunch(
          deps,
          { sandboxRowId: target.sandboxRowId, watched: true },
          bundleHash,
          args.signal,
        )
      ).fence;

      // The daemon may have recovered while the claim/fence round trips were
      // in flight. Release our temporary script lease before reusing it.
      const fencedRace = await reuseAgain();
      if (fencedRace) {
        await fence?.release();
        fence = null;
        return fencedRace;
      }
    }

    await sandbox.killBrowserd();
    const outcome = await namingProtocolMismatch(diagnostics, () =>
      bootAndPublish<SandboxHostedBrowserSessionHandle>(deps, {
        sandbox,
        contextMode,
        ...(args.profileArchive ? { profileArchive: args.profileArchive } : {}),
        reuseAgain,
        publish: async (booted) => {
          handle = booted;
          await recordLogicalBoot(deps, args, booted.bootId);
          stream = target.watched ? await sandbox.ensureStream() : undefined;
          const record = {
            sandboxRowId: target.sandboxRowId,
            bootId: booted.bootId,
            browserdToken: booted.bearer,
            browserdPort: booted.port,
            publicOrigin: booted.publicOrigin,
            bundleHash,
            contextMode,
            // Same daemon, same wire: a per-run box records what it speaks so
            // a later lookup can refuse it on `protocol_changed` rather than
            // adopt a daemon nothing can prove it can talk to.
            ...(booted.protocolVersion !== undefined
              ? { protocolVersion: booted.protocolVersion }
              : {}),
            ...(lookup.observedSessionId
              ? { replacesSessionId: lookup.observedSessionId }
              : {}),
            ...(args.logicalSessionId
              ? { logicalSessionId: args.logicalSessionId }
              : {}),
            ...(args.signal ? { signal: args.signal } : {}),
          };
          return stream
            ? deps.store.record({
                ...record,
                watched: true,
                stream: {
                  url: stream.streamUrl,
                  password: stream.streamPassword,
                },
              })
            : deps.store.record({ ...record, watched: false });
        },
        onAdopt: () => {
          handle = undefined;
        },
      }),
    );
    if (outcome.kind === "adopted") return outcome.handle;

    const booted = outcome.booted;
    handle = undefined; // recorded: the daemon now outlives this call
    // BOOT-TO-READY, recorded from the first run rather than guessed later.
    // Every iteration of a browser eval pays this before its first navigate,
    // and it is the number that decides whether warm pools are worth building.
    logger.info("[browser-session] browser.sandbox_boot", {
      sandboxRowId: target.sandboxRowId,
      connectMs: connectedAt - startedAt,
      bootMs: Date.now() - connectedAt,
      totalMs: Date.now() - startedAt,
    });
    return {
      engine: "hosted",
      target: "sandbox",
      sessionId: outcome.sessionId,
      sandboxRowId: target.sandboxRowId,
      sandboxId: target.sandboxId,
      bootId: booted.bootId,
      client: withActivityTouches(
        deps,
        { sessionId: outcome.sessionId },
        deps.createClient(booted.publicOrigin, booted.bearer),
        logicalContext,
      ),
      contextMode,
      reused: false,
      ...(target.watched ? { watched: true } : {}),
      ...(target.watched && stream
        ? { streamUrl: stream.streamUrl, streamPassword: stream.streamPassword }
        : {}),
    };
  } finally {
    // On any failure after a boot, never leave an unrecorded daemon running.
    await handle?.stop().catch(() => {});
    await sandbox.disconnect().catch(() => {});
    await fence?.release();
    await releaseClaim();
  }
}

async function ensureOnComputer(
  deps: BrowserSessionDeps,
  computerId: string,
  contextMode: BrowserContextMode,
  // Only the signal: the reserve's inputs are consumed by the caller, so this
  // function cannot accidentally reserve anything.
  args: Pick<
    EnsureBrowserSessionArgs,
    "signal" | "logicalSessionId" | "profileArchive" | "expectedExistingBootId"
  > &
    Partial<Pick<EnsureBrowserSessionArgs, "bearer" | "projectId">>,
): Promise<ComputerHostedBrowserSessionHandle> {
  const bundleHash = deps.bundleHash();
  const logicalContext = logicalContextFromArgs(args);
  // ONE BAG PER ENSURE. Written by whichever gate refuses a running daemon,
  // read only if the relaunch that refusal triggered then fails.
  const diagnostics: EnsureDiagnostics = {};
  await bindLogicalBox(deps, args, { computerId });
  const lookupArgs = {
    computerId,
    expectedBundleHash: bundleHash,
    expectedContextMode: contextMode,
    // Sent only while lazy upgrade is on. With the switch off the backend goes
    // back to answering `bundle_changed`, which is the pre-V-4a behaviour this
    // rollback is for.
    ...(lazyUpgradeEnabled()
      ? { expectedProtocolVersion: BROWSERD_PROTOCOL_VERSION }
      : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  };

  const lookup = await deps.store.lookup(lookupArgs);
  // GATE 3: the control plane refused the row before we ever reached the
  // daemon. `protocol_changed` is parsed off the wire and, until now, read by
  // nothing — the caller saw a stale row and relaunched, which is right, and
  // nobody could tell afterwards why.
  if (lookup.stale === "protocol_changed") {
    noteProtocolMismatch(
      diagnostics,
      {
        expected: BROWSERD_PROTOCOL_VERSION,
        running: lookup.session?.protocolVersion,
        stale: lookup.stale,
        source: "lookup",
      },
      { computerId, sessionId: lookup.observedSessionId },
    );
  }
  const reusedHandle = await tryReuse(
    deps,
    lookup,
    contextMode,
    args.signal,
    logicalContext,
    diagnostics,
  );
  if (reusedHandle) return reusedHandle;

  // An aborted lookup comes back indistinguishable from "no session" — the
  // client never throws — so check the signal before treating that answer as
  // grounds for a relaunch. Otherwise a caller merely going away (a cancelled
  // chat turn) would kill and reboot a durable daemon that is serving someone
  // else perfectly well.
  throwIfAborted(args.signal);

  // Relaunch. Everything below touches the sandbox; the connection is always
  // released, and a daemon that cannot be recorded is always stopped.
  const sandboxId = await deps.resolveSandboxId(computerId);
  const sandbox = await deps.connect(sandboxId);
  let handle: BrowserdHandle | undefined;
  let stream: { streamUrl: string; streamPassword: string } | undefined;
  /**
   * Give back the relaunch claim, whatever happens.
   *
   * Assigned only once a claim is actually held, so the `finally` below can
   * call it unconditionally. Everything the relaunch can do after taking it —
   * a refused fence, a kill that fails, a lost record, a thrown boot — has to
   * end with the claim released, or the next attempt waits out its whole TTL
   * for no reason.
   */
  let releaseClaim: () => Promise<void> = async () => {};
  try {
    // WAKE, THEN ASK AGAIN, before deciding the daemon is gone.
    //
    // `tryReuse` above deliberately never touches the sandbox, so a merely
    // PAUSED box fails its probe exactly like a dead daemon does. Connecting
    // is what resumes one — which has already happened by the time we get
    // here — so the probe that failed a moment ago may well succeed now, and
    // the whole relaunch below would be for nothing: it rotates `bootId` and
    // the stream password, so every open pane and every in-flight command
    // against this box breaks, to replace a daemon that was only asleep.
    const awake = await tryReuse(
      deps,
      lookup,
      contextMode,
      args.signal,
      logicalContext,
    );
    if (awake) return awake;

    // AND ANOTHER REPLICA MAY BE ABOUT TO DO THE SAME THING.
    //
    // The fence below is a lease on the daemon being replaced, which is
    // exactly the wrong tool for this: the race that hurts is the one where
    // there is no daemon yet to hold a lease on — a first boot, or a row the
    // sweep took — and there the second replica's `pkill` reaps the daemon the
    // first has just booted. The record compare-and-swap cannot save that
    // either, because it fires long after the kill and the damage IS the kill.
    //
    // So the claim comes first, and it lives in the control plane because that
    // is the only thing both replicas can see.
    const claimId = randomUUID();
    const claimed = await deps.store.claimRelaunch?.({
      computerId,
      claimId,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (claimed?.ok === false && claimed.reason === "claimed") {
      throw new BrowserSessionInUseError(
        "another replica is restarting this browser right now; try again in a moment",
      );
    }
    // `undefined` (no claim support) and `unavailable` (unreachable, or a
    // control plane that predates the route) both proceed unclaimed, as every
    // relaunch did before this existed. Releasing is then a no-op.
    if (claimed?.ok === true) {
      releaseClaim = async () => {
        await deps.store
          .releaseRelaunch?.({
            computerId,
            claimId,
            ...(args.signal ? { signal: args.signal } : {}),
          })
          .catch(() => {});
      };
    }

    // A person may be DRIVING this browser. The relaunch below pkills their
    // Chromium and rotates the boot, which from their side is the page
    // vanishing mid-login. The lease is the whole reason we can know that, so
    // take it — refusing if somebody else has it — rather than read it and
    // hope nobody acts in the gap.
    const { fence, owner } = await fenceForRelaunch(
      deps,
      { computerId },
      bundleHash,
      args.signal,
    );

    // IS ONE ALREADY RUNNING THAT WE CAN SIMPLY USE?
    //
    // The desktop image starts browserd itself, so on a fresh box there is a
    // healthy daemon listening before any inspector has done anything — and
    // the whole relaunch below (kill, upload, boot Chromium) would replace it
    // with an identical one, several seconds later. Adoption is what turns a
    // cold start into a warm one.
    //
    // Refused unless it can PROVE it is ours to use: it must have minted a
    // token into the file only `user` can read, answer `/v1/status` with that
    // bearer, speak this build's wire, and be running the profile mode this
    // caller asked for. Anything short of that and it is killed and replaced,
    // exactly as before.
    //
    // AND NEVER FATAL. Adoption is an optimisation over a path that already
    // works; a transient failure inside it — a stream that would not start, a
    // record that lost its race — must fall through to the kill-and-boot
    // below rather than fail the whole ensure, which would leave the caller
    // with no browser at all because a shortcut did not pay off.
    const adopted = await tryAdoptPrelaunched(
      deps,
      sandbox,
      {
        computerId,
        contextMode,
        observedSessionId: lookup.observedSessionId,
        ...(logicalContext ? { logicalContext } : {}),
      },
      args.signal,
      diagnostics,
    ).catch((error: unknown) => {
      logger.warn("[browser-session] prelaunch adoption failed; relaunching", {
        computerId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (adopted) {
      await fence?.release();
      return adopted;
    }

    // A WINNER MAY HAVE APPEARED WHILE WE WERE CONNECTING.
    //
    // Resuming a paused sandbox takes seconds, and another replica that lost
    // no time can boot and record inside them. Our own lookup is from before
    // all that, so the daemon it names is the dead one — and `killBrowserd`
    // is a `pkill` on the box, which would reap the WINNER'S new daemon and
    // leave their row pointing at nothing. The record CAS cannot save that:
    // it fires after the kill.
    //
    // The ownership lookup above is fresh and costs nothing extra, so ask it:
    // a different `bootId` means somebody else booted, and if that daemon
    // verifies it is the one to use. The fence goes back first — we may be
    // holding a lease on the very daemon we are about to hand over, and
    // returning a session the agent is blocked out of would be worse than the
    // relaunch.
    if (owner?.session && owner.session.bootId !== lookup.session?.bootId) {
      const winner = await tryReuse(
        deps,
        owner,
        contextMode,
        args.signal,
        logicalContext,
      );
      if (winner) {
        await fence?.release();
        return winner;
      }
    }

    try {
      await sandbox.killBrowserd();
    } catch (killError) {
      // The daemon is still alive and we are holding its lease. Left there it
      // would block the agent AND every person until it parked, which never
      // frees on its own.
      await fence?.release();
      throw killError;
    }

    // The stream, started INSIDE `publish` so its ordering relative to the
    // record cannot drift: the password exists nowhere else, so the row must
    // be written from the same start that minted it.
    const outcome = await namingProtocolMismatch(diagnostics, () =>
      bootAndPublish<ComputerHostedBrowserSessionHandle>(deps, {
        sandbox,
        contextMode,
        ...(args.profileArchive ? { profileArchive: args.profileArchive } : {}),
        reuseAgain: async () =>
          tryReuse(
            deps,
            await deps.store.lookup(lookupArgs),
            contextMode,
            args.signal,
            logicalContext,
          ),
        publish: async (booted) => {
          handle = booted;
          await recordLogicalBoot(deps, args, booted.bootId);
          stream = await sandbox.ensureStream();
          // Compare-and-swap against the row observed at lookup: if another
          // replica booted and recorded in the meantime, OUR daemon is the
          // loser — the winner's `pkill` may already have reaped it — so we
          // must not overwrite their credentials with a dead one.
          return deps.store.record({
            computerId,
            bootId: booted.bootId,
            browserdToken: booted.bearer,
            browserdPort: booted.port,
            publicOrigin: booted.publicOrigin,
            stream: {
              url: stream.streamUrl,
              password: stream.streamPassword,
            },
            bundleHash,
            contextMode,
            // The wire the daemon announced, so a later lookup can answer
            // "can I still talk to it?" without a probe.
            ...(booted.protocolVersion !== undefined
              ? { protocolVersion: booted.protocolVersion }
              : {}),
            ...(lookup.observedSessionId
              ? { replacesSessionId: lookup.observedSessionId }
              : {}),
            ...(args.logicalSessionId
              ? { logicalSessionId: args.logicalSessionId }
              : {}),
            ...(args.signal ? { signal: args.signal } : {}),
          });
        },
        onAdopt: () => {
          handle = undefined;
        },
      }),
    );
    if (outcome.kind === "adopted") return outcome.handle;

    const booted = outcome.booted;
    handle = undefined; // recorded: the daemon now outlives this call
    return {
      engine: "hosted",
      target: "computer",
      sessionId: outcome.sessionId,
      computerId,
      bootId: booted.bootId,
      client: withActivityTouches(
        deps,
        { sessionId: outcome.sessionId, computerId },
        deps.createClient(booted.publicOrigin, booted.bearer),
        logicalContext,
      ),
      streamUrl: stream!.streamUrl,
      streamPassword: stream!.streamPassword,
      contextMode,
      reused: false,
    };
  } finally {
    // On any failure after a boot, never leave an unrecorded daemon running;
    // never kill the durable computer itself.
    await handle?.stop().catch(() => {});
    await sandbox.disconnect().catch(() => {});
    // The claim last: it is the thing another replica is waiting on, and
    // holding it while this one tidies up is time nobody else can use.
    await releaseClaim();
  }
}
