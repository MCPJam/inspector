/**
 * The browser on THIS machine — the npm engine's half of the agent browser.
 *
 * The hosted engine reserves an E2B desktop, uploads a daemon bundle, boots it
 * and talks to it over HTTPS. None of that exists here. The same daemon stack
 * is constructed in this process (`buildBrowserdStack`), driving a Chromium
 * launched on the user's own machine, and reached through the in-process
 * client. Everything above the client — the six `browser_*` tools, the lease,
 * the queue, the observation budgets — is byte-identical to hosted, which is
 * the whole point: one abstraction, three engines.
 *
 * TRUST MODEL, mirroring `utils/computers/local-machine.ts`:
 *  - This is NOT a sandbox. The browser runs as the OS user, in a profile that
 *    persists their logins. The boundaries are device CONSENT, per-action chat
 *    approval, and the actor gates in `engine.ts` — never the profile path.
 *  - The profile directory is per project because a login for one project
 *    should not silently be a login for another, not because a path confines
 *    anything. What IS validated is the project key, which becomes a path
 *    segment under a fixed root.
 *  - Project secrets never reach this process's Chromium. The env allowlist in
 *    `local-machine.ts` is the precedent and this path does not widen it.
 *
 * LIFECYCLE. One browser per (project, context mode). It outlives a chat turn
 * — a login that vanished between turns would make the persistent profile
 * pointless — and is reaped when idle, when the server stops, and when the
 * desktop app quits. A reap while a person is holding the browser would close
 * the window they are typing into, so a held lease defers it.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { HOSTED_MODE, LOCAL_BROWSER_ENABLED } from "../../../config.js";
import { logger } from "../../../utils/logger.js";
import { validateLocalProjectKey } from "../../../utils/computers/local-machine.js";
import { isChromiumInstalled } from "../../../utils/browser-rendering-setup.js";
import { buildBrowserdStack, type BrowserdStack } from "../daemon/server.js";
import { ChromiumDriver } from "../daemon/chromium-driver.js";
import { HandoffLease } from "../daemon/lease.js";
import {
  launchBrowserdContext,
  type LaunchBrowserdContextOptions,
} from "../daemon/chromium-launch.js";
import type { DriverContext } from "../daemon/browser-page.js";
import { probeSingletonOwner } from "../daemon/profile-lock.js";
import { launchElectronContext } from "../electron/electron-context.js";
import {
  createContextSurface,
  forgetContextSurface,
  registerContextSurface,
  type ContextSurface,
} from "../electron/agent-surface.js";
import {
  createInProcessBrowserdClient,
  type InProcessBrowserdClient,
} from "../in-process-client.js";
import { withKeyedLock } from "../probe-lock.js";
import { formatBrowserdError } from "../protocol.js";
import type { LocalBrowserSessionHandle } from "../browser-session.js";
import type { BrowserContextMode } from "../browser-sessions-client.js";

/**
 * Where a project's browser profile lives.
 *
 * Under the same root as the local computer's workspaces (`~/.mcpjam/computer`)
 * rather than beside them, so "everything this machine holds for the agent" is
 * one directory a user can inspect or delete.
 */
export function getLocalBrowserRoot(): string {
  return join(homedir(), ".mcpjam", "computer", "browser");
}

export function getLocalBrowserProfileDir(projectId: string): string {
  const key = validateLocalProjectKey(projectId);
  const root = getLocalBrowserRoot();
  const dir = resolve(root, key, "profile");
  // Belt and braces over the key validation: the resolved path must still be
  // under the root. A key that ever slipped through the pattern would
  // otherwise write a Chromium profile wherever it pointed.
  if (!dir.startsWith(root + sep)) {
    throw new Error(`invalid local browser profile path for project ${key}`);
  }
  return dir;
}

/**
 * Which Chromium this machine's browser actually is.
 *
 * `playwright` downloads and launches one; `electron` drives the one the
 * desktop app already IS. They are the same engine to everything above —
 * `ComputerEngine` stays `"local"` and the tools, the lease, the pane and the
 * approval rules are untouched — because the only real difference is which
 * factory builds the `DriverContext`.
 */
export type LocalBrowserRuntime = "playwright" | "electron";

/**
 * Which runtime this process can drive.
 *
 * `process.versions.electron` rather than the `ELECTRON_APP` env var: the var
 * says how the app was STARTED, and a dev server started with it set is still
 * a plain Node process with no `BrowserWindow` to open. This asks the only
 * question that matters, and it cannot be wrong.
 */
export function resolveLocalBrowserRuntime(): LocalBrowserRuntime {
  return process.versions.electron ? "electron" : "playwright";
}

/**
 * How the pane will SEE this machine's browser.
 *
 * `native` is a real `WebContentsView` parented into the app's own window —
 * Chromium, a few hundred microseconds from the pixels. `frames` is the JPEG
 * screencast every other engine uses, and the only thing a Playwright browser
 * in another process can offer.
 *
 * The pane has to be told rather than guess: it decides whether to open a
 * frame socket at all, and a pane that opened one against a native surface
 * would pay for an encode nobody looks at — while a pane that DIDN'T, against
 * an engine with no views, would show a permanently blank rail.
 *
 * READ AT CALL TIME, from `env`, so `MCPJAM_BROWSER_NATIVE_SURFACE=false`
 * takes the whole feature out without a rebuild. Anything other than the exact
 * string leaves it on, matching every other switch in this wave.
 */
export function resolveLocalBrowserSurface(
  env: NodeJS.ProcessEnv = process.env,
  runtime: LocalBrowserRuntime = resolveLocalBrowserRuntime(),
): "native" | "frames" {
  if (runtime !== "electron") return "frames";
  return (env.MCPJAM_BROWSER_NATIVE_SURFACE ?? "") === "false"
    ? "frames"
    : "native";
}

/** Everything this module needs from the outside, injectable for tests. */
export interface LocalBrowserDeps {
  launch(options: LaunchBrowserdContextOptions): Promise<DriverContext>;
  /**
   * Hidden `BrowserWindow`s, for the packaged desktop app.
   *
   * The packaged app ships no `node_modules`, so `launch` above cannot work
   * there at all — `import("playwright")` rejects. This is the same engine
   * reaching a Chromium that is already on the machine.
   */
  launchElectron(options: {
    contextMode: BrowserContextMode;
    partitionKey?: string;
    /** Tabs as views the pane can show natively, rather than hidden windows. */
    nativeSurface?: boolean;
    /** The surface those views register with, bound to this boot's lease. */
    surface?: ContextSurface;
  }): Promise<DriverContext>;
  /** Which of the two this process can actually use. */
  runtime(): LocalBrowserRuntime;
  chromiumInstalled(): Promise<boolean>;
  probeProfileOwner(
    dir: string,
  ): Promise<{ live: boolean; pid?: number; host?: string }>;
  /**
   * Where a project's persistent profile lives.
   *
   * Injected so a test can be hermetic: the profile directory is CREATED (and
   * chmod'ed) before anything is launched, so a suite with a faked browser was
   * still writing into the developer's own `~/.mcpjam` tree.
   */
  profileDirFor(projectId: string): string;
  now(): number;
  env: NodeJS.ProcessEnv;
}

const liveDeps = (): LocalBrowserDeps => ({
  launch: launchBrowserdContext,
  launchElectron: launchElectronContext,
  runtime: resolveLocalBrowserRuntime,
  chromiumInstalled: isChromiumInstalled,
  probeProfileOwner: probeSingletonOwner,
  profileDirFor: getLocalBrowserProfileDir,
  now: Date.now,
  env: process.env,
});

export interface EnsureLocalBrowserArgs {
  projectId: string;
  /**
   * `persistent` (interactive) keeps the profile so a login survives between
   * turns. `ephemeral` (evals, swarms, journeys) has no profile at all, so one
   * run can never inherit another's cookies. This is a property of the
   * SURFACE, never of the project.
   */
  contextMode?: BrowserContextMode;
  /**
   * Ephemeral only: what this throwaway browser belongs to (an eval iteration,
   * a journey attempt). Two unattended runs on one project must not share a
   * browser, and without this they would collide on the project key alone.
   */
  ownerKey?: string;
  /**
   * Let this browser's ledger keep `type` values verbatim.
   *
   * A property of the DAEMON rather than of a command, so no envelope a caller
   * controls can ask for it. The door only ever passes it for an EPHEMERAL
   * profile — a persistent profile is somebody's real logged-in browser, and a
   * ledger that recorded what they typed into it would be the wrong default in
   * the one place it matters most.
   */
  captureTypedText?: boolean;
}

interface LocalSession {
  key: string;
  /**
   * The validated project this browser belongs to, kept alongside the key
   * because the key is not parseable back into one (an ephemeral owner key may
   * itself contain a colon). The frames socket compares it against the project
   * its nonce was minted for.
   */
  projectKey: string;
  stack: BrowserdStack;
  /**
   * The in-process client, kept alongside the handle's own.
   *
   * `handle.client` is the engine-agnostic `SessionClient` every surface talks
   * to; this is the same object at its real type. The agent door needs the
   * methods only this engine's client has — the ledger read and the record-only
   * refusal — and narrowing a union at each call site would be a cast asserting
   * something this module already knows.
   */
  inProcessClient: InProcessBrowserdClient;
  driver: ChromiumDriver;
  lease: HandoffLease;
  handle: LocalBrowserSessionHandle;
  context: DriverContext;
  lastUsedAt: number;
  startedAt: number;
  disposing: boolean;
  /** The in-flight teardown, so two callers await ONE close, not two. */
  disposal?: Promise<void>;
}

/** Idle and absolute lifetimes, matching the WebMCP session registry's. */
export const LOCAL_BROWSER_IDLE_MS = 10 * 60_000;
export const LOCAL_BROWSER_MAX_LIFETIME_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;

const sessions = new Map<string, LocalSession>();
let sweepTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
/**
 * Bumped by every sweep, latching or not.
 *
 * `shuttingDown` cannot answer "was this launch overtaken?" for the
 * NON-latching kill — Electron's `window-all-closed`, which must not latch or
 * every browser opened after reopening the window would be refused. A launch
 * that began before that sweep would otherwise register its Chromium
 * afterwards, holding the profile lock the next window needs.
 */
let killGeneration = 0;

function sessionKey(args: EnsureLocalBrowserArgs): string {
  const project = validateLocalProjectKey(args.projectId);
  if (args.contextMode !== "ephemeral") return `${project}:persistent`;
  // No fallback owner. An omitted key used to collapse to "anonymous", which
  // silently gave two unattended runs on one project ONE browser and one
  // cookie jar — the exact sharing an ephemeral context exists to prevent.
  // A caller that cannot name the run has to say so and be refused.
  const owner = args.ownerKey?.trim();
  if (!owner) {
    throw new LocalBrowserUnavailableError(
      "owner_key_required",
      "an ephemeral browser must name the run it belongs to; without an " +
        "ownerKey two unattended runs would share one profile",
    );
  }
  return `${project}:ephemeral:${owner}`;
}

/**
 * Should this launch open a real window?
 *
 * "No window" must not mean the old headless binary — sites fingerprint it,
 * and an agent that cannot load a login page is not an agent. The launcher
 * pins the full Chromium build; this only decides whether it is shown. A
 * window is opt-in because the common case (a server, a container, SSH) has no
 * display to put one on, and because the pane streams the page either way.
 */
function wantsHeadedWindow(env: NodeJS.ProcessEnv): boolean {
  if (env.MCPJAM_BROWSER_HEADED !== "1") return false;
  if (process.platform === "win32" || process.platform === "darwin")
    return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export class LocalBrowserUnavailableError extends Error {
  constructor(
    readonly code:
      | "chromium_not_installed"
      | "profile_in_use"
      | "disabled"
      | "owner_key_required",
    message: string,
  ) {
    super(message);
    this.name = "LocalBrowserUnavailableError";
  }
}

/**
 * Get (or start) this project's local browser.
 *
 * Serialized per key: two chat turns arriving together must not each launch a
 * Chromium on the same profile directory — the second would find the first's
 * singleton lock and fail, having already paid for a process.
 */
export async function ensureLocalBrowserSession(
  args: EnsureLocalBrowserArgs,
  deps: LocalBrowserDeps = liveDeps(),
): Promise<LocalBrowserSessionHandle> {
  // `shuttingDown` belongs here and not only in the sweep: a turn already in
  // flight when the process began terminating would otherwise launch a
  // Chromium that nothing is left to reap, and the profile lock would outlive
  // the inspector.
  if (HOSTED_MODE || !LOCAL_BROWSER_ENABLED || shuttingDown) {
    throw new LocalBrowserUnavailableError(
      "disabled",
      shuttingDown
        ? "the inspector is shutting down"
        : "the local browser engine is disabled on this server",
    );
  }
  const key = sessionKey(args);
  return withKeyedLock(`local-browser:${key}`, async () => {
    // Re-asked inside the lock: waiting for it can take as long as a teardown,
    // and the answer may have changed while we queued.
    if (shuttingDown) {
      throw new LocalBrowserUnavailableError(
        "disabled",
        "the inspector is shutting down",
      );
    }
    const existing = sessions.get(key);
    if (existing && !existing.disposing && existing.context.isConnected()) {
      existing.lastUsedAt = deps.now();
      return { ...existing.handle, reused: true };
    }
    // A browser that died (crash, or the user closed the window) leaves a
    // stale entry. Drop it rather than handing back a handle to a dead stack.
    if (existing) await disposeSession(existing).catch(() => {});
    return startSession(key, args, deps);
  });
}

async function startSession(
  key: string,
  args: EnsureLocalBrowserArgs,
  deps: LocalBrowserDeps,
): Promise<LocalBrowserSessionHandle> {
  // Which sweep generation this launch belongs to, read before the first await
  // in this function so a kill that lands during any of them is detectable
  // afterwards. The install probe below is an await too: read this first or a
  // kill during that probe is invisible and the launch survives the sweep.
  const bornAt = killGeneration;
  const runtime = deps.runtime();

  // Electron BRINGS its Chromium: there is nothing to install, and asking
  // would show the consent screen a download prompt for a browser the user
  // already has open.
  if (runtime === "playwright" && !(await deps.chromiumInstalled())) {
    // Never install from inside a chat turn: the download is hundreds of
    // megabytes and the model would sit in a tool call for minutes with no way
    // to say why. The consent screen installs it, with progress.
    throw new LocalBrowserUnavailableError(
      "chromium_not_installed",
      formatBrowserdError(
        "chromium_not_installed",
        "this machine has no Chromium for the agent to drive yet — open the Computer tab and install it, then try again",
      ),
    );
  }
  const contextMode: BrowserContextMode = args.contextMode ?? "persistent";
  const persistent = contextMode === "persistent";
  // Electron's profile is a session PARTITION, not a directory we create and
  // lock: `persist:mcpjam-browser-<key>` is the whole of it, managed by
  // Electron inside the app's own userData. So no directory, and no singleton
  // probe — the app's `requestSingleInstanceLock` already guarantees that one
  // process owns it, which is the thing the probe exists to establish.
  const profileDir =
    persistent && runtime === "playwright"
      ? deps.profileDirFor(args.projectId)
      : undefined;

  if (profileDir) {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await chmod(profileDir, 0o700).catch(() => {});
    // A profile directory is a Chromium SINGLETON. The hosted engine may clear
    // the lock unconditionally because it pkills the daemon first; here the
    // owner may be a second inspector server, or the user's own Chrome if they
    // pointed it at this directory. Killing that is not ours to do — say so
    // instead of launching into a directory someone else owns.
    const owner = await deps.probeProfileOwner(profileDir);
    if (owner.live) {
      throw new LocalBrowserUnavailableError(
        "profile_in_use",
        formatBrowserdError(
          "profile_in_use",
          owner.host
            ? `this project's browser profile is held by a process on ${owner.host} (pid ${owner.pid ?? "unknown"}) — it lives on a directory shared between machines, and opening it twice would corrupt it`
            : `another process (pid ${owner.pid ?? "unknown"}) is already using this project's browser profile; close it, or run this inspector with a different project`,
        ),
      );
    }
  }

  /**
   * The pane's own view of this browser, when it can have one.
   *
   * Created BEFORE the context, because the context registers each tab with it
   * as the tab is made — and the first tab is made during the launch below.
   *
   * `MCPJAM_BROWSER_NATIVE_SURFACE=false` restores the pre-V-3 shape exactly:
   * hidden windows and frames over a socket. Read at call time so a deployment
   * can flip it without a rebuild.
   */
  const nativeSurface =
    resolveLocalBrowserSurface(deps.env, runtime) === "native";
  const surface = nativeSurface ? createContextSurface() : undefined;

  const context =
    runtime === "electron"
      ? await deps.launchElectron({
          contextMode,
          nativeSurface,
          ...(surface ? { surface } : {}),
          ...(persistent
            ? { partitionKey: validateLocalProjectKey(args.projectId) }
            : {}),
        })
      : await deps.launch({
          userDataDir: profileDir ?? "",
          headless: !wantsHeadedWindow(deps.env),
          // The FULL Chromium build, not the headless shell: `headless: true`
          // alone selects `chromium-headless-shell`, which is the old headless
          // — a different binary with a different compositor path and a
          // fingerprint that public sites recognise and block.
          channel: "chromium",
          contextMode,
        });

  // The launch is the long await in this function, and a sweep can begin
  // inside it. A Chromium registered after the drain has already run is one
  // nothing is left to reap: it outlives the inspector holding the profile
  // lock, and the next run cannot open that profile at all.
  if (shuttingDown || killGeneration !== bornAt) {
    await context.close().catch(() => {});
    throw new LocalBrowserUnavailableError(
      "disabled",
      "the inspector is shutting down",
    );
  }

  /**
   * The lease drives the native surface, and the DAEMON owns the lease.
   *
   * This is the whole shape of the input gate: a real `WebContentsView` in the
   * user's window is a browser somebody can click into, so what decides whether
   * it is shown and whether it accepts input has to be the same authority that
   * already refuses the model's commands. A renderer-side check would be a
   * suggestion.
   */
  const lease = new HandoffLease(
    surface
      ? {
          onChange: (state) =>
            surface.setLease(
              state.state === "free"
                ? { state: "free" }
                : { state: state.state, holder: state.holder },
            ),
        }
      : {},
  );
  const driver = new ChromiumDriver(context, { lease });
  // A per-boot bearer even in-process. Nothing else can reach this handler, but
  // the token is what makes the in-process client the SAME client as hosted —
  // and a stack whose auth is disabled on one engine is a stack whose auth is
  // untested on that engine.
  const token = randomBytes(32).toString("hex");
  const stack = buildBrowserdStack(driver, {
    token,
    lease,
    contextMode,
    ...(args.captureTypedText ? { captureTypedText: true } : {}),
  });
  const client = createInProcessBrowserdClient(stack, token);
  // BY BOOT ID, which is what the renderer knows and the only thing it may
  // name: a renderer that could address a surface by index could reach another
  // project's browser by guessing.
  if (surface) registerContextSurface(stack.bootId, surface);

  const handle: LocalBrowserSessionHandle = {
    engine: "local",
    runtime,
    bootId: stack.bootId,
    client,
    contextMode,
    reused: false,
    ...(profileDir ? { profileDir } : {}),
  };
  const now = deps.now();
  const session: LocalSession = {
    key,
    projectKey: validateLocalProjectKey(args.projectId),
    stack,
    inProcessClient: client,
    driver,
    lease,
    handle,
    context,
    lastUsedAt: now,
    startedAt: now,
    disposing: false,
  };
  sessions.set(key, session);
  startSweep(deps);
  logger.info("[local-browser] started a browser for this machine", {
    contextMode,
    headed: wantsHeadedWindow(deps.env),
  });
  return handle;
}

/** Mark a session used, so watching or driving it defers the idle reap. */
export function touchLocalBrowserSession(
  handle: Pick<LocalBrowserSessionHandle, "bootId">,
  now: number = Date.now(),
): void {
  for (const session of sessions.values()) {
    if (session.stack.bootId === handle.bootId) session.lastUsedAt = now;
  }
}

/**
 * The live session behind a bootId, for the routes that drive the pane.
 *
 * Hands back the CLIENT rather than the raw stack: the client carries the
 * per-boot bearer, so a route cannot accidentally reach the handler
 * unauthenticated — and the handler is where the lease is enforced. `handler`
 * comes along only for the frame subscription, which is a stream rather than a
 * request and so has no client method.
 */
export function findLocalBrowserSession(bootId: string):
  | {
      client: InProcessBrowserdClient;
      handler: BrowserdStack["handler"];
      handle: LocalBrowserSessionHandle;
      /**
       * This boot's command ledger.
       *
       * Handed over directly rather than read back through `/v1/trace`, because
       * on this engine the daemon is in THIS process: the mirror would
       * otherwise serialize every row to JSON and parse it again to copy it
       * into a file a few lines away. The ledger is a read-and-drain buffer,
       * not a rule to be enforced, so there is nothing here for the handler to
       * gate — unlike a command, which must go through the client.
       */
      ledger: BrowserdStack["ledger"];
      /** For callers that must prove the session is the one they may reach. */
      projectKey: string;
    }
  | undefined {
  for (const session of sessions.values()) {
    if (session.stack.bootId === bootId) {
      return {
        client: session.inProcessClient,
        handler: session.stack.handler,
        handle: session.handle,
        ledger: session.stack.ledger,
        projectKey: session.projectKey,
      };
    }
  }
  return undefined;
}

/**
 * The PERSISTENT browser a project has open on this machine, if any — for a
 * caller that wants to read it without starting one.
 *
 * `ensureLocalBrowserSession` is the wrong tool for that: it launches a
 * Chromium when none is running, and the Tools pane listing a page's tools
 * must never be what opens a browser window on somebody's desk. Only the
 * persistent profile is considered: ephemeral contexts belong to unattended
 * runs, which no pane is watching.
 *
 * Throws (from the key validator) on a malformed project id, exactly as the
 * ensure path does, so a route can answer 400 rather than 404.
 */
export function findLocalBrowserSessionForProject(projectId: string):
  | {
      client: InProcessBrowserdClient;
      handle: LocalBrowserSessionHandle;
      ledger: BrowserdStack["ledger"];
      projectKey: string;
    }
  | undefined {
  const project = validateLocalProjectKey(projectId);
  const session = sessions.get(`${project}:persistent`);
  if (!session) return undefined;
  return {
    client: session.inProcessClient,
    handle: session.handle,
    ledger: session.stack.ledger,
    projectKey: session.projectKey,
  };
}

/** Every live local browser, for status routes and the reap. */
export function listLocalBrowserSessions(): Array<{
  key: string;
  handle: LocalBrowserSessionHandle;
  lastUsedAt: number;
  leaseHeld: boolean;
}> {
  return [...sessions.values()].map((session) => ({
    key: session.key,
    handle: session.handle,
    lastUsedAt: session.lastUsedAt,
    leaseHeld: session.lease.isBlocking(),
  }));
}

function startSweep(deps: LocalBrowserDeps): void {
  if (sweepTimer || shuttingDown) return;
  sweepTimer = setInterval(() => {
    void sweepLocalBrowserSessions(deps.now());
  }, SWEEP_INTERVAL_MS);
  // Never hold the process open for a sweep.
  sweepTimer.unref?.();
}

/**
 * Is this session still one the reaper may take?
 *
 * Shared by the scan and the re-check inside the lock so the two can never
 * disagree about what "expired" means.
 */
function stillReapable(session: LocalSession, now: number): boolean {
  // A Chromium that has gone away cannot be handed back, whatever its clock or
  // its lease say.
  if (!session.context.isConnected()) return true;
  const idle = now - session.lastUsedAt;
  const age = now - session.startedAt;
  const expired =
    idle >= LOCAL_BROWSER_IDLE_MS || age >= LOCAL_BROWSER_MAX_LIFETIME_MS;
  if (!expired) return false;
  // Only a HELD lease is a person at the keyboard. A PARKED one is an expired
  // hold — the pane stopped its heartbeat — and deferring for that would make
  // every abandoned hold immortal. See the long note at the call site.
  return session.lease.state().state !== "held";
}

export async function sweepLocalBrowserSessions(
  now: number = Date.now(),
): Promise<void> {
  for (const session of [...sessions.values()]) {
    if (session.disposing) continue;
    // A person HOLDING the browser is using it, even though no command has
    // come through for ten minutes — that is what taking control means. Reaping
    // here would close the window they are typing a password into.
    //
    // Only while there is still a browser to hold, though: a Chromium that has
    // gone away cannot be handed back, and a lease left held on a dead session
    // would otherwise refresh `lastUsedAt` on every sweep and keep the corpse
    // for the life of the process.
    //
    // And only a HELD lease, not any blocking one. Parking is what an expired
    // hold becomes, so it means the pane stopped its heartbeat: the tab was
    // closed, or reloaded, or the machine slept. Deferring for that too made
    // every abandoned hold immortal on a LIVE session — a Chromium and its
    // profile pinned open past the hard lifetime with nobody on either end,
    // because `isBlocking()` is true for both states. Parking still blocks the
    // AGENT, which is all it is for.
    if (!stillReapable(session, now)) {
      // Refresh the clock only for a browser somebody is HOLDING, so a long
      // login is not reaped out from under them. Not for every session that
      // merely has not expired yet: the sweep runs every 30 s, so refreshing
      // there would push `lastUsedAt` forward forever and the idle reap could
      // never fire at all.
      if (
        session.context.isConnected() &&
        session.lease.state().state === "held"
      ) {
        session.lastUsedAt = now;
      }
      continue;
    }
    logger.info("[local-browser] reaping an idle browser", {
      reason: session.context.isConnected() ? "idle" : "disconnected",
    });
    // Under the SAME per-key lock `ensureLocalBrowserSession` takes, so a turn
    // arriving mid-teardown waits for the profile lock to be released instead
    // of racing the dying Chromium for it and getting `profile_in_use`.
    //
    // And the decision is re-made INSIDE it. Everything above was read before
    // queueing for the lock, and a turn that arrived meanwhile has already
    // reused this session — closing it now would take the browser away from
    // somebody who is using it, on the strength of a reading that is no longer
    // true.
    await withKeyedLock(`local-browser:${session.key}`, async () => {
      const current = sessions.get(session.key);
      if (current !== session || current.disposing) return;
      if (!stillReapable(current, now)) return;
      await disposeSession(current);
    }).catch(() => {});
  }
  if (sessions.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

/**
 * Close one browser cleanly.
 *
 * Order matters: the driver closes its tabs and the context (which is what
 * lets Chromium write out and RELEASE the profile's singleton lock), and only
 * then is the entry dropped. A kill that skipped the context close would leave
 * the lock behind and make the next launch on that profile fail — the exact
 * failure `probeSingletonOwner` then has to reason about.
 */
function disposeSession(session: LocalSession): Promise<void> {
  // One teardown per session, however many callers ask for it: the sweep and
  // an `ensure` that found the entry dead can arrive together.
  if (session.disposal) return session.disposal;
  session.disposing = true;
  session.disposal = (async () => {
    // FIRST, so a pane that is mid-resize cannot reparent a view into a window
    // whose context is already closing. The context's own `close()` disposes
    // the surface too; this is the registry entry, which nothing else drops.
    forgetContextSurface(session.stack.bootId);
    session.stack.server.close();
    await Promise.race([
      session.driver.close(),
      new Promise((r) => setTimeout(r, 5_000)),
    ]).catch(() => {});
    // Dropped AFTER the close, not before: closing the context is what makes
    // Chromium release the profile's singleton lock, and a caller who found no
    // entry would launch straight into the lock the dying process still holds.
    if (sessions.get(session.key) === session) sessions.delete(session.key);
  })();
  return session.disposal;
}

/** Close every local browser. Non-latching: the app may start another. */
/**
 * Close ONE local browser, by the boot the caller is looking at.
 *
 * `killLocalBrowserSessions` closes every browser on the machine, which is the
 * right answer for a shutdown and the wrong one for "this agent is finished
 * with its session": another project's browser has nothing to do with it.
 *
 * Answers whether it found one, so a caller can tell "closed it" apart from
 * "there was nothing there" — which for a non-idempotent terminate is a
 * distinction the caller asked for.
 */
export async function closeLocalBrowserSession(
  bootId: string,
): Promise<{ closed: true } | { closed: false; reason: "not_found" | "lease_held" }> {
  for (const session of sessions.values()) {
    if (session.stack.bootId !== bootId) continue;
    // RE-CHECKED HERE, not only by the caller. A route asks the lease and then
    // awaits — reading the session, writing the participant list — and a person
    // can take the browser inside that window. Closing it then shuts the window
    // they are typing into, which is the one thing termination must never do.
    if (session.lease.isBlocking()) {
      return { closed: false, reason: "lease_held" };
    }
    session.stack.closeStreams();
    await disposeSession(session);
    return { closed: true };
  }
  return { closed: false, reason: "not_found" };
}

export async function killLocalBrowserSessions(): Promise<void> {
  killGeneration += 1;
  await Promise.all(
    [...sessions.values()].map((s) =>
      withKeyedLock(`local-browser:${s.key}`, () => disposeSession(s)).catch(
        () => {},
      ),
    ),
  );
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

/** Close every local browser and refuse new ones. For process shutdown. */
export async function shutdownLocalBrowserSessions(): Promise<void> {
  shuttingDown = true;
  await killLocalBrowserSessions();
}

/** Test seam: the module holds process-wide state by design. */
export async function resetLocalBrowserSessionsForTests(): Promise<void> {
  shuttingDown = false;
  killGeneration = 0;
  await killLocalBrowserSessions();
}
