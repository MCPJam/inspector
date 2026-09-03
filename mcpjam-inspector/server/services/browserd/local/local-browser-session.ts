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
import { createInProcessBrowserdClient } from "../in-process-client.js";
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

/** Everything this module needs from the outside, injectable for tests. */
export interface LocalBrowserDeps {
  launch(options: LaunchBrowserdContextOptions): Promise<DriverContext>;
  chromiumInstalled(): Promise<boolean>;
  probeProfileOwner(dir: string): Promise<{ live: boolean; pid?: number }>;
  now(): number;
  env: NodeJS.ProcessEnv;
}

const liveDeps = (): LocalBrowserDeps => ({
  launch: launchBrowserdContext,
  chromiumInstalled: isChromiumInstalled,
  probeProfileOwner: probeSingletonOwner,
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
  driver: ChromiumDriver;
  lease: HandoffLease;
  handle: LocalBrowserSessionHandle;
  context: DriverContext;
  lastUsedAt: number;
  startedAt: number;
  disposing: boolean;
}

/** Idle and absolute lifetimes, matching the WebMCP session registry's. */
export const LOCAL_BROWSER_IDLE_MS = 10 * 60_000;
export const LOCAL_BROWSER_MAX_LIFETIME_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;

const sessions = new Map<string, LocalSession>();
let sweepTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;

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
  if (process.platform === "win32" || process.platform === "darwin") return true;
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
  if (HOSTED_MODE || !LOCAL_BROWSER_ENABLED) {
    throw new LocalBrowserUnavailableError(
      "disabled",
      "the local browser engine is disabled on this server",
    );
  }
  const key = sessionKey(args);
  return withKeyedLock(`local-browser:${key}`, async () => {
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
  if (!(await deps.chromiumInstalled())) {
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
  const profileDir = persistent
    ? getLocalBrowserProfileDir(args.projectId)
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
          `another process (pid ${owner.pid ?? "unknown"}) is already using this project's browser profile; close it, or run this inspector with a different project`,
        ),
      );
    }
  }

  const context = await deps.launch({
    userDataDir: profileDir ?? "",
    headless: !wantsHeadedWindow(deps.env),
    // The FULL Chromium build, not the headless shell: `headless: true` alone
    // selects `chromium-headless-shell`, which is the old headless — a
    // different binary with a different compositor path and a fingerprint that
    // public sites recognise and block.
    channel: "chromium",
    contextMode,
  });

  const lease = new HandoffLease();
  const driver = new ChromiumDriver(context, { lease });
  // A per-boot bearer even in-process. Nothing else can reach this handler, but
  // the token is what makes the in-process client the SAME client as hosted —
  // and a stack whose auth is disabled on one engine is a stack whose auth is
  // untested on that engine.
  const token = randomBytes(32).toString("hex");
  const stack = buildBrowserdStack(driver, { token, lease });
  const client = createInProcessBrowserdClient(stack, token);

  const handle: LocalBrowserSessionHandle = {
    engine: "local",
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
      client: LocalBrowserSessionHandle["client"];
      handler: BrowserdStack["handler"];
      handle: LocalBrowserSessionHandle;
      /** For callers that must prove the session is the one they may reach. */
      projectKey: string;
    }
  | undefined {
  for (const session of sessions.values()) {
    if (session.stack.bootId === bootId) {
      return {
        client: session.handle.client,
        handler: session.stack.handler,
        handle: session.handle,
        projectKey: session.projectKey,
      };
    }
  }
  return undefined;
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

export async function sweepLocalBrowserSessions(
  now: number = Date.now(),
): Promise<void> {
  for (const session of [...sessions.values()]) {
    if (session.disposing) continue;
    const idle = now - session.lastUsedAt;
    const age = now - session.startedAt;
    const expired =
      idle >= LOCAL_BROWSER_IDLE_MS || age >= LOCAL_BROWSER_MAX_LIFETIME_MS;
    if (!expired && session.context.isConnected()) continue;
    // A person holding the browser IS using it, even though no command has
    // come through for ten minutes — that is what taking control means. Reaping
    // here would close the window they are typing a password into.
    if (expired && session.lease.isBlocking()) {
      session.lastUsedAt = now;
      continue;
    }
    logger.info("[local-browser] reaping an idle browser", {
      reason: session.context.isConnected() ? "idle" : "disconnected",
    });
    await disposeSession(session).catch(() => {});
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
async function disposeSession(session: LocalSession): Promise<void> {
  session.disposing = true;
  sessions.delete(session.key);
  session.stack.server.close();
  await Promise.race([
    session.driver.close(),
    new Promise((r) => setTimeout(r, 5_000)),
  ]).catch(() => {});
}

/** Close every local browser. Non-latching: the app may start another. */
export async function killLocalBrowserSessions(): Promise<void> {
  await Promise.all(
    [...sessions.values()].map((s) => disposeSession(s).catch(() => {})),
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
  await killLocalBrowserSessions();
}
