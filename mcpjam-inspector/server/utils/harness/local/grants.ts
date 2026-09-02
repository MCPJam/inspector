/**
 * Workspace grants and local harness consent — the two pieces of local state
 * that decide whether a turn may run on this machine at all.
 *
 * ── Why this is not the existing device consent ───────────────────────────
 * `computers/local-consent.ts` already proves "the human allowed agents to run
 * commands on this machine". That is the right primitive for a discrete,
 * per-command, chat-approved `bash` call. It is the WRONG authorization for a
 * long-lived vendor harness: the two differ in duration, in blast radius, and
 * in what the user was actually shown. Reusing it would silently upgrade a
 * device-level "yes" into "yes, start an agent with a permission profile you
 * never saw, against a runtime you never saw, in a directory you never picked".
 *
 * So local harness execution mints its OWN grant, bound to every identity that
 * changes what the user agreed to (invariant 14): user, machine, project,
 * canonical workspace, harness, target mode, isolation backend, runtime
 * identity, permission profile, and policy version. Change any of them and the
 * binding no longer matches, so the grant is unusable and the user is asked
 * again — which is the honest behavior, not an inconvenience.
 *
 * ── What is persisted ────────────────────────────────────────────────────
 * Only a SHA-256 of the capability token, alongside the binding, at 0600 in an
 * owner-only directory, written atomically. The plaintext lives with the
 * client that minted it. Same shape, and the same honest caveat, as the device
 * consent it sits beside: a process already running as this OS user can edit
 * the file. What this defends is a client — or a remote page, or a script —
 * starting a host agent without a human having deliberately chosen these exact
 * terms.
 *
 * ── Why a path never travels ─────────────────────────────────────────────
 * A raw host path is not an authorization primitive. Callers name a workspace
 * by an opaque `workspaceGrantId`; only this module, inside the local trusted
 * process, turns that back into a canonical path. A renderer that could submit
 * a path could submit any path.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { logger } from "../../logger.js";
import {
  LOCAL_HARNESS_POLICY_VERSION,
  LOCAL_ISOLATION_POLICY_VERSION,
  type LocalIsolationBackend,
  type LocalPermissionProfile,
  type SupportedLocalHarnessId,
} from "./targets.js";
import { createLocalStateMutationLock } from "./local-state-lock.js";

export const LOCAL_HARNESS_GRANT_HEADER = "x-mcpjam-local-harness-grant";

/** Owner-only root for every piece of local-harness trusted state. */
export function localHarnessStateRoot(): string {
  return join(homedir(), ".mcpjam", "harness-local");
}

function grantsFilePath(): string {
  return join(localHarnessStateRoot(), "grants.json");
}

function machineFilePath(): string {
  return join(localHarnessStateRoot(), "machine.json");
}

export interface WorkspaceGrant {
  workspaceGrantId: string;
  /** Canonical (symlink-resolved) absolute path. Local trusted state only. */
  canonicalPath: string;
  createdAt: string;
}

/**
 * Everything a harness grant is bound to. Every field is part of what the user
 * was shown; a change to any of them means they consented to something else.
 */
export interface HarnessGrantBinding {
  userId: string;
  machineId: string;
  projectId: string;
  workspaceGrantId: string;
  harnessId: SupportedLocalHarnessId;
  targetKind: "local-native" | "local-isolated";
  backend?: LocalIsolationBackend;
  runtimeId: string;
  permissionProfile: LocalPermissionProfile;
  /** The local-harness policy version. Applies to EVERY local target: the argv
   *  denylist, the environment allowlist, and the permission mapping govern an
   *  isolated session just as much as a native one. */
  policyVersion: string;
  /** The isolation policy version. Present only for an isolated target, where
   *  the backend and its mount/syscall/egress rules are also part of what the
   *  user was shown. */
  isolationPolicyVersion?: string;
}

interface PersistedHarnessGrant {
  grantId: string;
  tokenHash: string;
  bindingHash: string;
  binding: HarnessGrantBinding;
  grantedAt: string;
  expiresAt: string;
}

interface PersistedState {
  version: 1;
  workspaces: WorkspaceGrant[];
  harnessGrants: PersistedHarnessGrant[];
}

function emptyState(): PersistedState {
  return { version: 1, workspaces: [], harnessGrants: [] };
}

/** Grants are attended and short-lived by construction: local execution is not
 *  an unattended capability in v1, so a grant that outlives the sitting is a
 *  grant nobody is watching. */
const GRANT_TTL_MS = 12 * 60 * 60 * 1000;

/** Grant, revoke, workspace registration, and machine-id minting all mutate
 * owner-only state. The lock is cross-process so a second Inspector window
 * cannot overwrite a revocation made by the first. */
const withGrantLock = createLocalStateMutationLock({
  rootDir: localHarnessStateRoot,
  lockFileName: "grants.lock",
  resourceLabel: "grant store",
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Canonical serialization of a binding — field order is fixed here, so two
 *  bindings that differ anywhere hash differently and a reordered object
 *  literal cannot change the answer. */
export function hashGrantBinding(binding: HarnessGrantBinding): string {
  return sha256(
    JSON.stringify([
      binding.userId,
      binding.machineId,
      binding.projectId,
      binding.workspaceGrantId,
      binding.harnessId,
      binding.targetKind,
      binding.backend ?? null,
      binding.runtimeId,
      binding.permissionProfile,
      binding.policyVersion,
      // Only isolated bindings carry one, and only they hash it. A native
      // binding has no isolation policy to be bound to, so folding a constant
      // `null` into its hash would change every native hash for a value that
      // means nothing there — invalidating consents that the local policy
      // never touched. A native binding that carries one anyway is refused
      // outright by `verifyLocalHarnessGrant`, not admitted by the hash.
      ...(binding.targetKind === "local-isolated"
        ? [binding.isolationPolicyVersion ?? null]
        : []),
    ]),
  );
}

/** Existing security state that cannot be understood is never treated as an
 * empty store: doing so lets the next mutation overwrite grants or resurrect
 * a revocation from a concurrent writer's stale snapshot. */
export class GrantStateUnreadableError extends Error {}

function isValidDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isWorkspaceGrant(value: unknown): value is WorkspaceGrant {
  if (!value || typeof value !== "object") return false;
  const workspace = value as Partial<WorkspaceGrant>;
  return (
    typeof workspace.workspaceGrantId === "string" &&
    workspace.workspaceGrantId.length > 0 &&
    typeof workspace.canonicalPath === "string" &&
    workspace.canonicalPath.length > 0 &&
    isValidDate(workspace.createdAt)
  );
}

function isHarnessGrantBinding(value: unknown): value is HarnessGrantBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<HarnessGrantBinding>;
  const isolatedBackend =
    binding.backend === "linux-bwrap" ||
    binding.backend === "darwin-seatbelt" ||
    binding.backend === "oci-v1" ||
    binding.backend === "vm-v1";
  return (
    typeof binding.userId === "string" &&
    binding.userId.length > 0 &&
    typeof binding.machineId === "string" &&
    binding.machineId.length > 0 &&
    typeof binding.projectId === "string" &&
    binding.projectId.length > 0 &&
    typeof binding.workspaceGrantId === "string" &&
    binding.workspaceGrantId.length > 0 &&
    (binding.harnessId === "claude-code" || binding.harnessId === "codex") &&
    (binding.targetKind === "local-native" ||
      binding.targetKind === "local-isolated") &&
    typeof binding.runtimeId === "string" &&
    binding.runtimeId.length > 0 &&
    (binding.permissionProfile === "read-only" ||
      binding.permissionProfile === "workspace-edits" ||
      binding.permissionProfile === "unrestricted") &&
    typeof binding.policyVersion === "string" &&
    binding.policyVersion.length > 0 &&
    (binding.targetKind === "local-native"
      ? binding.backend === undefined &&
        binding.isolationPolicyVersion === undefined
      : isolatedBackend &&
        typeof binding.isolationPolicyVersion === "string" &&
        binding.isolationPolicyVersion.length > 0)
  );
}

function isPersistedHarnessGrant(
  value: unknown,
): value is PersistedHarnessGrant {
  if (!value || typeof value !== "object") return false;
  const grant = value as Partial<PersistedHarnessGrant>;
  return (
    typeof grant.grantId === "string" &&
    grant.grantId.length > 0 &&
    typeof grant.tokenHash === "string" &&
    /^[0-9a-f]{64}$/.test(grant.tokenHash) &&
    typeof grant.bindingHash === "string" &&
    /^[0-9a-f]{64}$/.test(grant.bindingHash) &&
    isHarnessGrantBinding(grant.binding) &&
    isValidDate(grant.grantedAt) &&
    isValidDate(grant.expiresAt)
  );
}

async function readState(): Promise<PersistedState> {
  let raw: string;
  try {
    raw = await readFile(grantsFilePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw new GrantStateUnreadableError(
      `the local harness grant store could not be read: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GrantStateUnreadableError(
      "the local harness grant store is corrupt; refusing to treat it as " +
        "empty or overwrite it",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new GrantStateUnreadableError(
      "the local harness grant store is not an object",
    );
  }
  const record = parsed as Partial<PersistedState>;
  if (
    record.version !== 1 ||
    !Array.isArray(record.workspaces) ||
    !Array.isArray(record.harnessGrants) ||
    !record.workspaces.every(isWorkspaceGrant) ||
    !record.harnessGrants.every(isPersistedHarnessGrant)
  ) {
    throw new GrantStateUnreadableError(
      "the local harness grant store has an unrecognized or malformed shape",
    );
  }
  return {
    version: 1,
    workspaces: [...record.workspaces],
    harnessGrants: [...record.harnessGrants],
  };
}

async function writeState(state: PersistedState): Promise<void> {
  const dir = localHarnessStateRoot();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const file = grantsFilePath();
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * Stable per-machine identifier.
 *
 * A random UUID persisted at 0600 — NOT a hardware or MAC-derived value. The
 * only job is "is this the same installation the grant was minted on", and a
 * random id does that without minting a cross-install fingerprint that would
 * then have to be kept out of telemetry.
 */
export async function getLocalMachineId(): Promise<string> {
  const readExisting = async (): Promise<string | null> => {
    let raw: string;
    try {
      raw = await readFile(machineFilePath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new GrantStateUnreadableError(
        `the local harness machine identity could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new GrantStateUnreadableError(
        "the local harness machine identity is corrupt; refusing to replace it",
      );
    }
    if (!parsed || typeof parsed !== "object") {
      throw new GrantStateUnreadableError(
        "the local harness machine identity has an unrecognized shape",
      );
    }
    const machineId = (parsed as { machineId?: unknown }).machineId;
    if (typeof machineId !== "string" || machineId.length < 8) {
      throw new GrantStateUnreadableError(
        "the local harness machine identity has an invalid id",
      );
    }
    return machineId;
  };

  const existing = await readExisting();
  if (existing !== null) return existing;

  return withGrantLock(async () => {
    // Re-read inside the cross-process lock: another Inspector may have
    // minted the installation identity while this caller was waiting.
    const raced = await readExisting();
    if (raced !== null) return raced;

    const machineId = `mach_${randomUUID()}`;
    const dir = localHarnessStateRoot();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = machineFilePath();
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({ machineId }), { mode: 0o600 });
    await rename(tmp, file);
    return machineId;
  });
}

export type WorkspaceGrantResult =
  | { ok: true; grant: WorkspaceGrant }
  | { ok: false; message: string };

/**
 * Register a directory the user picked, and return its opaque id.
 *
 * The path is canonicalized HERE (`realpath`), so a symlinked selection is
 * recorded as what it actually resolves to and every later confinement check
 * compares against that. Callers must have obtained the path from a trusted
 * picker — the Electron main-process dialog, or a loopback-only,
 * session-authenticated route — never from a renderer-submitted string.
 */
export function registerWorkspaceGrant(
  rawPath: string,
): Promise<WorkspaceGrantResult> {
  return withGrantLock(async () => {
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(rawPath);
      const info = await stat(canonicalPath);
      if (!info.isDirectory()) {
        return {
          ok: false as const,
          message: "the selection is not a directory",
        };
      }
    } catch (error) {
      return {
        ok: false as const,
        message: `the selected workspace could not be resolved: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    // Refuse the obviously wrong roots. A home directory or a filesystem root
    // as "the workspace" makes the workspace label meaningless.
    // Compare against the RESOLVED home: on a machine where the home
    // directory is itself a symlink, the raw value never equals the
    // canonicalized selection and the refusal below would not fire.
    const home = await realpath(homedir()).catch(() => homedir());
    if (canonicalPath === home || canonicalPath === sep) {
      return {
        ok: false as const,
        message:
          "pick a project directory rather than your home directory or the " +
          "filesystem root — the workspace is what the session is scoped to.",
      };
    }

    const state = await readState();
    const existing = state.workspaces.find(
      (w) => w.canonicalPath === canonicalPath,
    );
    if (existing) return { ok: true as const, grant: existing };

    const grant: WorkspaceGrant = {
      workspaceGrantId: `ws_${randomUUID()}`,
      canonicalPath,
      createdAt: new Date().toISOString(),
    };
    state.workspaces.push(grant);
    await writeState(state);
    logger.info("[local-harness] workspace grant registered");
    return { ok: true as const, grant };
  });
}

/** Resolve an opaque workspace id to its canonical path, re-checking that the
 *  directory still resolves to the SAME place — a workspace replaced by a
 *  symlink after registration is not the workspace that was granted. */
export async function resolveWorkspaceGrant(
  workspaceGrantId: string,
): Promise<
  { ok: true; canonicalPath: string } | { ok: false; message: string }
> {
  let state: PersistedState;
  try {
    state = await readState();
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "the local harness grant store could not be read",
    };
  }
  const grant = state.workspaces.find(
    (w) => w.workspaceGrantId === workspaceGrantId,
  );
  if (!grant) {
    return { ok: false, message: "unknown workspace grant" };
  }
  try {
    const canonical = await realpath(grant.canonicalPath);
    if (canonical !== grant.canonicalPath) {
      return {
        ok: false,
        message:
          "the granted workspace now resolves somewhere else; re-select it " +
          "before running locally",
      };
    }
    const info = await stat(canonical);
    if (!info.isDirectory()) {
      return {
        ok: false,
        message: "the granted workspace is no longer a directory",
      };
    }
    return { ok: true, canonicalPath: canonical };
  } catch {
    return {
      ok: false,
      message: "the granted workspace is no longer reachable",
    };
  }
}

export interface MintedHarnessGrant {
  grantId: string;
  /** Plaintext capability. Returned exactly once; only its hash is stored. */
  token: string;
  expiresAt: string;
}

/**
 * Mint a harness grant for one exact set of terms.
 *
 * `policyVersion` is taken from the binding rather than read here on purpose:
 * the caller states which policy the user was shown, and a mismatch with the
 * current constant is caught at verification instead of being papered over at
 * mint time.
 */
export function grantLocalHarnessConsent(
  binding: HarnessGrantBinding,
  opts?: { ttlMs?: number; now?: number },
): Promise<MintedHarnessGrant> {
  return withGrantLock(async () => {
    const now = opts?.now ?? Date.now();
    // Clamped, never trusted: a caller asking for a longer life than the
    // attended maximum is asking for an unattended capability, which is the
    // one thing a v1 local grant must not be.
    // Only the CEILING matters: asking for longer than the attended maximum is
    // asking for an unattended capability. A shorter grant is strictly safer,
    // so it is honoured as given.
    const ttlMs = Math.min(opts?.ttlMs ?? GRANT_TTL_MS, GRANT_TTL_MS);
    const token = randomBytes(32).toString("base64url");
    const grant: PersistedHarnessGrant = {
      grantId: `grant_${randomUUID()}`,
      tokenHash: sha256(token),
      bindingHash: hashGrantBinding(binding),
      binding,
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    const state = await readState();
    // One live grant per binding: re-consenting rotates rather than
    // accumulating capabilities nobody can enumerate.
    state.harnessGrants = state.harnessGrants.filter(
      (g) => g.bindingHash !== grant.bindingHash,
    );
    state.harnessGrants.push(grant);
    await writeState(state);
    logger.info("[local-harness] consent granted", {
      harnessId: binding.harnessId,
      targetKind: binding.targetKind,
      permissionProfile: binding.permissionProfile,
      policyVersion: binding.policyVersion,
    });
    return { grantId: grant.grantId, token, expiresAt: grant.expiresAt };
  });
}

export type GrantVerification =
  | { ok: true; grantId: string }
  | {
      ok: false;
      reason: "absent" | "expired" | "binding-mismatch" | "invalid";
      message: string;
    };

/**
 * Verify a presented capability against the terms it must have been minted
 * for. Constant-time on the token compare; the binding is compared by hash so
 * a caller cannot pass a binding that merely looks similar.
 */
export async function verifyLocalHarnessGrant(
  token: string | null | undefined,
  binding: HarnessGrantBinding,
  opts?: { now?: number },
): Promise<GrantVerification> {
  if (!token || token.length < 16 || token.length > 256) {
    return {
      ok: false,
      reason: "invalid",
      message: "no local harness grant was presented",
    };
  }
  // BOTH policies must be current for an isolated target. The local-harness
  // policy governs argv, environment, and permission mapping for every local
  // session; the isolation policy adds the backend's own rules on top. Binding
  // only one of them would let a change to the other pass unnoticed.
  if (binding.policyVersion !== LOCAL_HARNESS_POLICY_VERSION) {
    return {
      ok: false,
      reason: "binding-mismatch",
      message:
        `this grant was minted under policy ${binding.policyVersion}; the ` +
        `current policy is ${LOCAL_HARNESS_POLICY_VERSION}. The terms ` +
        `changed, so consent is asked again.`,
    };
  }
  if (binding.targetKind === "local-isolated") {
    if (binding.isolationPolicyVersion !== LOCAL_ISOLATION_POLICY_VERSION) {
      return {
        ok: false,
        reason: "binding-mismatch",
        message:
          `this grant was minted under isolation policy ` +
          `${binding.isolationPolicyVersion ?? "(none)"}; the current ` +
          `isolation policy is ${LOCAL_ISOLATION_POLICY_VERSION}.`,
      };
    }
  } else if (binding.isolationPolicyVersion !== undefined) {
    return {
      ok: false,
      reason: "binding-mismatch",
      message: "a native grant must not carry an isolation policy version",
    };
  }
  const bindingHash = hashGrantBinding(binding);
  let state: PersistedState;
  try {
    state = await readState();
  } catch (error) {
    return {
      ok: false,
      reason: "invalid",
      message:
        error instanceof Error
          ? error.message
          : "the local harness grant store could not be read",
    };
  }
  const presented = Buffer.from(sha256(token), "hex");
  const now = opts?.now ?? Date.now();

  for (const grant of state.harnessGrants) {
    const stored = Buffer.from(grant.tokenHash, "hex");
    if (presented.length !== stored.length) continue;
    if (!timingSafeEqual(presented, stored)) continue;
    if (grant.bindingHash !== bindingHash) {
      return {
        ok: false,
        reason: "binding-mismatch",
        message:
          "the presented grant was issued for different terms (workspace, " +
          "harness, runtime, target mode, permission profile, or policy " +
          "version). Local execution never runs under terms the user did not " +
          "see.",
      };
    }
    if (Date.parse(grant.expiresAt) <= now) {
      return {
        ok: false,
        reason: "expired",
        message:
          "the local harness grant expired; consent is attended and short-lived",
      };
    }
    return { ok: true, grantId: grant.grantId };
  }
  return {
    ok: false,
    reason: "absent",
    message: "no local harness grant matches the presented capability",
  };
}

/** Revoke by grant id, by binding, or — with no argument — every grant on this
 *  machine (the "stop everything" affordance). */
export function revokeLocalHarnessGrants(selector?: {
  grantId?: string;
  binding?: HarnessGrantBinding;
}): Promise<number> {
  return withGrantLock(async () => {
    const state = await readState();
    const before = state.harnessGrants.length;
    if (!selector) {
      state.harnessGrants = [];
    } else if (selector.grantId) {
      state.harnessGrants = state.harnessGrants.filter(
        (g) => g.grantId !== selector.grantId,
      );
    } else if (selector.binding) {
      const hash = hashGrantBinding(selector.binding);
      state.harnessGrants = state.harnessGrants.filter(
        (g) => g.bindingHash !== hash,
      );
    }
    const removed = before - state.harnessGrants.length;
    if (removed > 0) {
      await writeState(state);
      logger.info("[local-harness] consent revoked", { removed });
    }
    return removed;
  });
}

/** Drop expired grants. Called by the janitor; safe to call at any time. */
export function pruneExpiredHarnessGrants(now = Date.now()): Promise<number> {
  return withGrantLock(async () => {
    const state = await readState();
    const before = state.harnessGrants.length;
    state.harnessGrants = state.harnessGrants.filter(
      (g) => Date.parse(g.expiresAt) > now,
    );
    const removed = before - state.harnessGrants.length;
    if (removed > 0) await writeState(state);
    return removed;
  });
}
